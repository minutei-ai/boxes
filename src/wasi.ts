import { Clock, Effect, Match, Schema } from "effect";
import wasm from "cirro:wasi";
import { createBindings } from "../dist/wasi/bindings";
import { requirePermission } from "./auth";
import { Capability, Fault, FileStat, RunResult, WasmStep } from "./contracts";
import type { open } from "./storage";
import { kernelCall, publish, read, write } from "./storage";
import type { Env } from "./resources";

export class WasmFailure extends Schema.TaggedError<WasmFailure>()("WasmFailure", {
  cause: Schema.Unknown,
}) {}

export const wasi = Effect.fn("wasi.execute")(function* (
  env: Env,
  capability: typeof Capability.Type,
  source: string,
  initial: Effect.Success<ReturnType<typeof open>>,
) {
  const policy = initial.head.policy;
  const guest = yield* Effect.acquireRelease(
    Effect.try({
      try: () => {
        const bindings = createBindings();
        bindings.initSync({ module: wasm });
        return new bindings.WasmGuest(
          Buffer.from(source, "base64"),
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
          yield* write(env, capability.sandboxId, kernel, input.path, Buffer.from(data));
          state.dirty = true;
          return { data: Buffer.alloc(0), path: "/", directory: false, value: 0n };
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
      yield* Effect.try({
        try: () => guest.respond(0, value.data, value.path, value.directory, value.value),
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
          ["ENOSPC", 51],
          ["ENOMEM", 48],
          ["EFBIG", 22],
          ["ELOOP", 32],
          ["ENOTCAPABLE", 76],
          ["EIO", 29],
        ]).get(response.failure.code) ?? 28;
      yield* Effect.try({
        try: () => guest.respond(errno, Buffer.alloc(0), "/", false, 0n),
        catch: (cause) => new WasmFailure({ cause }),
      });
    }
  }
  return completed[0];
});
