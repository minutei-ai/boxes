import { Clock, Duration, Effect, Match, Schema, Struct } from "effect";
import wasm from "cirro:wasi";
import { createBindings } from "../dist/wasi/bindings";
import { requirePermission } from "./auth";
import {
  Capability,
  CapturedStdio,
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
import type { OutputCapture } from "./output";
import type { Env } from "./resources";

export class WasmFailure extends Schema.TaggedError<WasmFailure>()("WasmFailure", {
  cause: Schema.Unknown,
}) {}

const statBytes = (stat: typeof FileStat.Type) => {
  const bytes = Buffer.alloc(76);
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
  const kind = Match.value(stat.kind).pipe(
    Match.when("file", () => 0o100000),
    Match.when("directory", () => 0o40000),
    Match.when("symlink", () => 0o120000),
    Match.exhaustive,
  );
  bytes.writeUInt32LE(kind | stat.mode, 64);
  bytes.writeUInt32LE(stat.uid, 68);
  bytes.writeUInt32LE(stat.gid, 72);
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
  capture: OutputCapture | null,
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
  const kernel = initial.kernel;
  const checkpoint = yield* kernelCall(() => kernel.manifest());
  const state = { session: initial, dirty: checkpoint !== initial.head.manifest, checkpoint };
  return yield* Effect.gen(function* () {
    const completed: (typeof RunResult.Type)[] = [];
    while (completed.length === 0) {
      const now = yield* Clock.currentTimeMillis;
      if (capability.expiresAt <= now)
        return yield* new Fault({
          code: "UNAUTHORIZED",
          status: 401,
          message: "Capability expired",
        });
      const raw = yield* Effect.try({
        try: () => guest.step(),
        catch: (cause) => new WasmFailure({ cause }),
      });
      const step = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(WasmStep), {
        onExcessProperty: "error",
      })(raw);
      if (capture !== null && step.kind !== "done") {
        const rawStdio = yield* Effect.try({
          try: () => guest.stdio(),
          catch: (cause) => new WasmFailure({ cause }),
        });
        const stdio = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(CapturedStdio))(
          rawStdio,
        );
        yield* capture(stdio);
      }
      const authorizedAt = yield* Clock.currentTimeMillis;
      if (capability.expiresAt <= authorizedAt)
        return yield* new Fault({
          code: "UNAUTHORIZED",
          status: 401,
          message: "Capability expired",
        });
      const timestamp = yield* Clock.currentTimeNanos;
      yield* kernelCall(() => kernel.set_time(timestamp));
      if (step.kind === "done") {
        if (state.dirty) {
          yield* publish(env, capability.sandboxId, state.session);
          state.checkpoint = state.session.head.manifest;
        }
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
                if (found === null) yield* kernelCall(() => kernel.chmod(path, input.mode));
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
              return yield* read(
                env,
                capability.sandboxId,
                kernel,
                path,
                !input.read && input.write,
              );
            });
            return { data, path, directory: false, value: 0n };
          }),
        ),
        Match.when({ kind: "tmpfile" }, (input) =>
          Effect.gen(function* () {
            yield* requirePermission(capability, "write");
            if (input.read) yield* requirePermission(capability, "read");
            const directory = yield* kernelCall(() => kernel.realpath(input.path));
            if (
              input.base !== "/" &&
              directory !== input.base &&
              !directory.startsWith(input.base + "/")
            )
              return yield* new Fault({
                code: "ENOTCAPABLE",
                status: 403,
                message: "Temporary file escapes its directory descriptor",
              });
            const stat = yield* kernelCall(() => kernel.temporary_file(directory, input.mode)).pipe(
              Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(FileStat))),
            );
            state.dirty = true;
            const data = statBytes(stat);
            return { data, path: directory, directory: false, value: 0n };
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
        Match.when({ kind: "fdTimes" }, (input) =>
          Effect.gen(function* () {
            yield* requirePermission(capability, "write");
            if (input.path === null) {
              const metadata = Buffer.from(guest.file_metadata(input.fd));
              if ((input.flags & 1) !== 0) metadata.writeBigUInt64LE(BigInt(input.atime), 40);
              if ((input.flags & 2) !== 0) metadata.writeBigUInt64LE(timestamp, 40);
              if ((input.flags & 4) !== 0) metadata.writeBigUInt64LE(BigInt(input.mtime), 48);
              if ((input.flags & 8) !== 0) metadata.writeBigUInt64LE(timestamp, 48);
              if (input.flags !== 0) metadata.writeBigUInt64LE(timestamp, 56);
              return { data: metadata, path: "/", directory: false, value: 0n };
            }
            const path = input.path;
            yield* kernelCall(() =>
              kernel.set_times(path, true, BigInt(input.atime), BigInt(input.mtime), input.flags),
            );
            if (input.flags !== 0) state.dirty = true;
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
        Match.when({ kind: "pathTimes" }, (input) =>
          Effect.gen(function* () {
            yield* requirePermission(capability, "write");
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
                message: "WASI timestamps follow a symlink outside its directory descriptor",
              });
            yield* kernelCall(() =>
              kernel.set_times(
                stat.path,
                input.follow,
                BigInt(input.atime),
                BigInt(input.mtime),
                input.flags,
              ),
            );
            if (input.flags !== 0) state.dirty = true;
            const updated = yield* kernelCall(() => kernel.stat(stat.path, input.follow)).pipe(
              Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(FileStat))),
            );
            return {
              data: statBytes(updated),
              path: updated.path,
              directory: updated.kind === "directory",
              value: 0n,
            };
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
              data: Buffer.from(
                Schema.encodeSync(Schema.fromJsonString(DirectoryEntries))(entries),
              ),
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
        Match.when({ kind: "poll" }, (input) =>
          Effect.gen(function* () {
            const realtime = yield* Clock.currentTimeNanos;
            const monotonic = yield* Clock.monotonicTimeNanos;
            const deadlines = input.clocks.map((clock) => {
              const now = Match.value(clock.clock).pipe(
                Match.when(0, () => realtime),
                Match.orElse(() => monotonic),
              );
              const deadline = Match.value(clock.absolute).pipe(
                Match.when(true, () => BigInt(clock.timeout)),
                Match.orElse(() => now + BigInt(clock.timeout)),
              );
              return {
                index: clock.index,
                clock: clock.clock,
                deadline,
                precision: BigInt(clock.precision),
                remaining: deadline - now,
              };
            });
            const readings = { realtime, monotonic };
            while (
              !input.immediate &&
              !deadlines.some((clock) => {
                const actual = Match.value(clock.clock).pipe(
                  Match.when(0, () => readings.realtime),
                  Match.orElse(() => readings.monotonic),
                );
                return clock.deadline <= actual;
              })
            ) {
              const untilExpiry = BigInt(capability.expiresAt) * 1_000_000n - readings.realtime;
              if (untilExpiry <= 0n)
                return yield* new Fault({
                  code: "UNAUTHORIZED",
                  status: 401,
                  message: "Capability expired while waiting",
                });
              const first = deadlines.reduce((minimum, clock) => {
                const actual = Match.value(clock.clock).pipe(
                  Match.when(0, () => readings.realtime),
                  Match.orElse(() => readings.monotonic),
                );
                const remaining = clock.deadline - actual;
                if (remaining < minimum) return remaining;
                return minimum;
              }, untilExpiry);
              yield* Effect.sleep(Duration.nanos(((first + 999_999n) / 1_000_000n) * 1_000_000n));
              readings.realtime = yield* Clock.currentTimeNanos;
              readings.monotonic = yield* Clock.monotonicTimeNanos;
            }
            const now = yield* Clock.currentTimeMillis;
            if (capability.expiresAt <= now)
              return yield* new Fault({
                code: "UNAUTHORIZED",
                status: 401,
                message: "Capability expired while waiting",
              });
            const actualRealtime = readings.realtime;
            const actualMonotonic = readings.monotonic;
            const ready = deadlines
              .filter((clock) => {
                const actual = Match.value(clock.clock).pipe(
                  Match.when(0, () => actualRealtime),
                  Match.orElse(() => actualMonotonic),
                );
                return clock.deadline <= actual;
              })
              .map((clock) => clock.index);
            return {
              data: Buffer.from(
                Schema.encodeSync(Schema.fromJsonString(Schema.Array(Schema.Int)))(ready),
              ),
              path: "/",
              directory: false,
              value: 0n,
            };
          }),
        ),
        Match.when({ kind: "sync" }, () =>
          Effect.gen(function* () {
            if (state.dirty) {
              yield* publish(env, capability.sandboxId, state.session);
              state.checkpoint = state.session.head.manifest;
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
          if (step.kind === "tmpfile") return value.data;
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
          try: () =>
            guest.respond(0, value.data, value.path, value.directory, value.value, metadata),
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
            ["EROFS", 69],
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
  }).pipe(
    Effect.onError(() =>
      kernelCall(() => kernel.restore_manifest(state.checkpoint)).pipe(Effect.orDie),
    ),
  );
});
