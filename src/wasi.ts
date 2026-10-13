import { Clock, Effect, Match, Schema, Struct } from "effect";
import wasm from "cirro:wasi";
import { createBindings } from "../dist/wasi/bindings";
import { requirePermission } from "./auth";
import {
  Capability,
  Fault,
  FileStat,
  DirectoryEntries,
  RunResult,
  WasmStep,
  WasmProgram,
  WasmConfiguration,
} from "./contracts";
import type { open } from "./storage";
import { kernelCall, publish, read, write } from "./storage";
import type { Kernel } from "../dist/kernel/cirro_kernel";
import type { Env } from "./resources";

export class WasmFailure extends Schema.TaggedError<WasmFailure>()("WasmFailure", {
  cause: Schema.Unknown,
}) {}

const statBytes = (stat: typeof FileStat.Type) => {
  const bytes = Buffer.alloc(64);
  bytes.writeBigUInt64LE(BigInt(stat.inode), 8);
  bytes[16] = Match.value(stat.kind).pipe(
    Match.when("file", () => 4),
    Match.when("directory", () => 3),
    Match.orElse(() => 7),
  );
  bytes.writeBigUInt64LE(BigInt(stat.nlink), 24);
  bytes.writeBigUInt64LE(BigInt(stat.size), 32);
  bytes.writeBigUInt64LE(BigInt(stat.atimeNs), 40);
  bytes.writeBigUInt64LE(BigInt(stat.mtimeNs), 48);
  bytes.writeBigUInt64LE(BigInt(stat.ctimeNs), 56);
  return bytes;
};

const resolvePath = Effect.fn("wasi.resolvePath")(function* (
  kernel: Kernel,
  path: string,
  base: string,
) {
  const parent = path.slice(0, path.lastIndexOf("/"));
  const directory = yield* kernelCall(() => kernel.realpath(parent || "/"));
  const leaf = path.slice(path.lastIndexOf("/"));
  const resolved = Match.value(directory).pipe(
    Match.when("/", () => leaf),
    Match.orElse(() => directory + leaf),
  );
  if (base !== "/" && resolved !== base && !resolved.startsWith(base + "/"))
    return yield* new Fault({
      code: "ENOTCAPABLE",
      status: 403,
      message: "WASI path escapes its directory descriptor",
    });
  return resolved;
});

export const wasi = Effect.fn("wasi.execute")(function* (
  env: Env,
  capability: typeof Capability.Type,
  program: typeof WasmProgram.Type,
  initial: Effect.Success<ReturnType<typeof open>>,
) {
  const policy = initial.head.policy;
  const guest = yield* Effect.acquireRelease(
    Effect.try({
      try: () => {
        const bindings = createBindings();
        bindings.initSync({ module: wasm });
        return new bindings.WasmGuest(
          Buffer.from(program.source, "base64"),
          Schema.encodeSync(
            Schema.fromJsonString(
              WasmConfiguration.mapFields((fields) => Struct.omit(fields, ["stdin"])),
            ),
          )(program),
          Buffer.from(program.stdin, "base64"),
          policy.memoryBytes,
          BigInt(policy.interruptBudget) * 1000n,
          policy.maxOutputBytes,
        );
      },
      catch: (cause) => new WasmFailure({ cause }),
    }),
    (guest) => Effect.sync(() => guest.free()),
  );
  const state = { session: initial, dirty: false };
  const kernel = initial.kernel;
  const completed: (typeof RunResult.Type)[] = [];
  while (completed.length === 0) {
    const now = yield* Clock.currentTimeMillis;
    if (capability.expiresAt <= now)
      return yield* new Fault({ code: "UNAUTHORIZED", status: 401, message: "Capability expired" });
    const raw = yield* Effect.try({
      try: () => guest.step(),
      catch: (cause) => new WasmFailure({ cause }),
    });
    const step = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(WasmStep), {
      onExcessProperty: "error",
    })(raw);
    const authorizedAt = yield* Clock.currentTimeMillis;
    if (capability.expiresAt <= authorizedAt)
      return yield* new Fault({ code: "UNAUTHORIZED", status: 401, message: "Capability expired" });
    const timestamp = yield* Clock.currentTimeNanos;
    yield* kernelCall(() => kernel.set_time(timestamp));
    if (step.kind === "done") {
      if (state.dirty) yield* publish(env, capability.sandboxId, state.session);
      completed.push(step.output);
      continue;
    }
    const response = yield* Match.value(step).pipe(
      Match.when({ kind: "open" }, (input) =>
        Effect.gen(function* () {
          if (input.read || !input.write) yield* requirePermission(capability, "read");
          if (input.write || input.create || input.truncate)
            yield* requirePermission(capability, "write");
          if (
            (input.truncate && !input.write) ||
            (input.exclusive && !input.create) ||
            (input.directory && input.create)
          )
            return yield* new Fault({
              code: "EINVAL",
              status: 400,
              message: "Invalid WASI open flags",
            });
          const found = yield* kernelCall(() => kernel.stat(input.path, input.follow)).pipe(
            Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(FileStat))),
            Effect.catchTag("Fault", (fault) => {
              if (fault.code === "ENOENT" && input.create) return Effect.succeed(null);
              return Effect.fail(fault);
            }),
          );
          if (found !== null && found.kind === "symlink")
            return yield* new Fault({
              code: "ELOOP",
              status: 400,
              message: "WASI open does not follow this symlink",
            });
          if (found !== null && input.create && input.exclusive)
            return yield* new Fault({
              code: "EEXIST",
              status: 409,
              message: "WASI exclusive file already exists",
            });
          if (found !== null && input.write && (found.mode & 0o200) === 0)
            return yield* new Fault({
              code: "EACCES",
              status: 403,
              message: "WASI file is not writable",
            });
          const parent = input.path.slice(0, input.path.lastIndexOf("/"));
          const path = yield* Effect.gen(function* () {
            if (found !== null) return found.path;
            const directory = yield* kernelCall(() => kernel.realpath(parent || "/"));
            if (directory === "/") return input.path.slice(input.path.lastIndexOf("/"));
            return directory + input.path.slice(input.path.lastIndexOf("/"));
          });
          if (input.base !== "/" && path !== input.base && !path.startsWith(input.base + "/"))
            return yield* new Fault({
              code: "ENOTCAPABLE",
              status: 403,
              message: "WASI symlink escapes its directory descriptor",
            });
          if (found !== null && input.directory && found.kind !== "directory")
            return yield* new Fault({
              code: "ENOTDIR",
              status: 400,
              message: "WASI directory open requires a directory",
            });
          if (found !== null && found.kind === "directory") {
            if (input.truncate || input.write)
              return yield* new Fault({
                code: "EISDIR",
                status: 400,
                message: "WASI cannot write a directory",
              });
            return { data: Buffer.alloc(0), path, directory: true, value: 0n };
          }
          const data = yield* Effect.gen(function* () {
            if (found === null || input.truncate) {
              yield* write(env, capability.sandboxId, kernel, path, Buffer.alloc(0));
              state.dirty = true;
              return Buffer.alloc(0);
            }
            if (guest.has_file(path)) return Buffer.alloc(0);
            if (found.size + guest.buffered_bytes() > 16_777_216)
              return yield* new Fault({
                code: "ENOMEM",
                status: 413,
                message: "WASI open buffers exceed 16 MiB",
              });
            return yield* read(env, capability.sandboxId, kernel, path, !input.read && input.write);
          });
          return { data, path, directory: false, value: 0n };
        }),
      ),
      Match.when({ kind: "flush" }, (input) =>
        Effect.gen(function* () {
          yield* requirePermission(capability, "write");
          const data = yield* Effect.try({
            try: () => guest.file_data(input.fd),
            catch: (cause) => new WasmFailure({ cause }),
          });
          if (input.path === null) {
            const metadata = Buffer.from(guest.file_metadata(input.fd));
            metadata.writeBigUInt64LE(BigInt(data.byteLength), 32);
            metadata.writeBigUInt64LE(timestamp, 48);
            metadata.writeBigUInt64LE(timestamp, 56);
            return { data: metadata, path: "/", directory: false, value: 0n };
          }
          yield* write(env, capability.sandboxId, kernel, input.path, Buffer.from(data));
          state.dirty = true;
          return { data: Buffer.alloc(0), path: "/", directory: false, value: 0n };
        }),
      ),
      Match.when({ kind: "fdStat" }, (input) =>
        Effect.gen(function* () {
          if (input.write) yield* requirePermission(capability, "write");
          else yield* requirePermission(capability, "read");
          if (input.path === null)
            return {
              data: Buffer.from(guest.file_metadata(input.fd)),
              path: "/",
              directory: false,
              value: 0n,
            };
          const path = input.path;
          const stat = yield* kernelCall(() => kernel.stat(path, true)).pipe(
            Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(FileStat))),
          );
          return {
            data: statBytes(stat),
            path: stat.path,
            directory: stat.kind === "directory",
            value: 0n,
          };
        }),
      ),
      Match.when({ kind: "pathStat" }, (input) =>
        Effect.gen(function* () {
          yield* requirePermission(capability, "read");
          const path = yield* resolvePath(kernel, input.path, input.base);
          const stat = yield* kernelCall(() => kernel.stat(path, input.follow)).pipe(
            Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(FileStat))),
          );
          if (
            input.base !== "/" &&
            stat.path !== input.base &&
            !stat.path.startsWith(input.base + "/")
          )
            return yield* new Fault({
              code: "ENOTCAPABLE",
              status: 403,
              message: "WASI stat follows a symlink outside its directory descriptor",
            });
          return {
            data: statBytes(stat),
            path: stat.path,
            directory: stat.kind === "directory",
            value: 0n,
          };
        }),
      ),
      Match.when({ kind: "directory" }, (input) =>
        Effect.gen(function* () {
          yield* requirePermission(capability, "read");
          const json = yield* kernelCall(() => kernel.readdir(input.path));
          const entries = yield* Schema.decodeUnknownEffect(
            Schema.fromJsonString(DirectoryEntries),
          )(json);
          return {
            data: Buffer.from(Schema.encodeSync(Schema.fromJsonString(DirectoryEntries))(entries)),
            path: input.path,
            directory: true,
            value: 0n,
          };
        }),
      ),
      Match.when({ kind: "mkdir" }, (input) =>
        Effect.gen(function* () {
          yield* requirePermission(capability, "write");
          const path = yield* resolvePath(kernel, input.path, input.base);
          const existing = yield* kernelCall(() => kernel.stat(path, false)).pipe(Effect.result);
          if (existing._tag === "Success")
            return yield* new Fault({
              code: "EEXIST",
              status: 409,
              message: "WASI directory already exists",
            });
          if (existing.failure._tag !== "Fault" || existing.failure.code !== "ENOENT")
            return yield* existing.failure;
          yield* kernelCall(() => kernel.mkdir(path, false));
          state.dirty = true;
          return { data: Buffer.alloc(0), path, directory: true, value: 0n };
        }),
      ),
      Match.when({ kind: "remove" }, (input) =>
        Effect.gen(function* () {
          yield* requirePermission(capability, "write");
          const path = yield* resolvePath(kernel, input.path, input.base);
          const stat = yield* kernelCall(() => kernel.stat(path, false)).pipe(
            Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(FileStat))),
          );
          if (input.directory && stat.kind !== "directory")
            return yield* new Fault({
              code: "ENOTDIR",
              status: 400,
              message: "WASI remove_directory requires a directory",
            });
          if (!input.directory && stat.kind === "directory")
            return yield* new Fault({
              code: "EISDIR",
              status: 400,
              message: "WASI unlink_file cannot remove a directory",
            });
          yield* kernelCall(() => kernel.remove(path, false));
          state.dirty = true;
          return { data: Buffer.alloc(0), path, directory: input.directory, value: 0n };
        }),
      ),
      Match.when({ kind: "rename" }, (input) =>
        Effect.gen(function* () {
          yield* requirePermission(capability, "write");
          const from = yield* resolvePath(kernel, input.from, input.fromBase);
          const to = yield* resolvePath(kernel, input.to, input.toBase);
          yield* kernelCall(() => kernel.rename(from, to));
          state.dirty = true;
          return { data: Buffer.from(to), path: from, directory: false, value: 0n };
        }),
      ),
      Match.when({ kind: "symlink" }, (input) =>
        Effect.gen(function* () {
          yield* requirePermission(capability, "write");
          const path = yield* resolvePath(kernel, input.path, input.base);
          yield* kernelCall(() => kernel.symlink(input.target, path));
          state.dirty = true;
          return { data: Buffer.alloc(0), path, directory: false, value: 0n };
        }),
      ),
      Match.when({ kind: "readlink" }, (input) =>
        Effect.gen(function* () {
          yield* requirePermission(capability, "read");
          const path = yield* resolvePath(kernel, input.path, input.base);
          const target = yield* kernelCall(() => kernel.readlink(path));
          return { data: Buffer.from(target), path, directory: false, value: 0n };
        }),
      ),
      Match.when({ kind: "sync" }, () =>
        Effect.gen(function* () {
          if (state.dirty) {
            const etag = yield* publish(env, capability.sandboxId, state.session);
            state.session = { ...state.session, etag };
            state.dirty = false;
          }
          return { data: Buffer.alloc(0), path: "/", directory: false, value: 0n };
        }),
      ),
      Match.when({ kind: "random" }, (input) =>
        Effect.sync(() => ({
          data: Buffer.from(crypto.getRandomValues(new Uint8Array(input.length))),
          path: "/",
          directory: false,
          value: 0n,
        })),
      ),
      Match.when({ kind: "clock" }, (input) =>
        Effect.gen(function* () {
          if (input.clock === 0) {
            const now = yield* Clock.currentTimeMillis;
            return {
              data: Buffer.alloc(0),
              path: "/",
              directory: false,
              value: BigInt(now) * 1_000_000n,
            };
          }
          const nanos = yield* Clock.monotonicTimeNanos;
          return { data: Buffer.alloc(0), path: "/", directory: false, value: nanos };
        }),
      ),
      Match.exhaustive,
      Effect.result,
    );
    if (response._tag === "Success") {
      const value = response.success;
      const metadata = yield* Effect.gen(function* () {
        if (step.kind === "open") {
          const stat = yield* kernelCall(() => kernel.stat(value.path, true)).pipe(
            Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(FileStat))),
          );
          return statBytes(stat);
        }
        if (step.kind === "flush") {
          if (step.path === null) return value.data;
          const path = step.path;
          const stat = yield* kernelCall(() => kernel.stat(path, true)).pipe(
            Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(FileStat))),
          );
          return statBytes(stat);
        }
        return Buffer.alloc(0);
      });
      yield* Effect.try({
        try: () => guest.respond(0, value.data, value.path, value.directory, value.value, metadata),
        catch: (cause) => new WasmFailure({ cause }),
      });
    } else {
      if (response.failure._tag !== "Fault") return yield* response.failure;
      if (response.failure.code === "CONFLICT") return yield* response.failure;
      const errno =
        new Map([
          ["FORBIDDEN", 2],
          ["EACCES", 2],
          ["EPERM", 63],
          ["ENOENT", 44],
          ["EEXIST", 20],
          ["EISDIR", 31],
          ["ENOTDIR", 54],
          ["ENOTEMPTY", 55],
          ["ENOSPC", 51],
          ["ENOMEM", 48],
          ["EFBIG", 22],
          ["ELOOP", 32],
          ["ENOTCAPABLE", 76],
          ["EIO", 29],
        ]).get(response.failure.code) ?? 28;
      yield* Effect.try({
        try: () => guest.respond(errno, Buffer.alloc(0), "/", false, 0n, Buffer.alloc(0)),
        catch: (cause) => new WasmFailure({ cause }),
      });
    }
  }
  return completed[0];
});
