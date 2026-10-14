import { Clock, Effect, Schema } from "effect";
import { Capability, Fault, InputHead, ProcessInputAction, StoredRun } from "./contracts";
import { requirePermission } from "./auth";
import { head, StorageFailure } from "./storage";
import { restore } from "./code";
import type { Env } from "./resources";

const load = Effect.fn("input.load")(function* (env: Env, sandboxId: string, id: string) {
  const object = yield* Effect.tryPromise({
    try: () => env.OBJECTS.get(`process-input/${sandboxId}/${id}.json`),
    catch: (cause) => new StorageFailure({ cause }),
  });
  if (object === null)
    return yield* new StorageFailure({ cause: "Missing interactive input head" });
  if (object.size > 131_072) return yield* new StorageFailure({ cause: "Oversized input head" });
  const text = yield* Effect.tryPromise({
    try: () => object.text(),
    catch: (cause) => new StorageFailure({ cause }),
  });
  const input = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(InputHead))(text);
  if (input.chunks.reduce((size, chunk) => size + chunk.size, 0) !== input.size)
    return yield* new StorageFailure({ cause: "Input chunk sizes do not match its head" });
  return { input, etag: object.etag };
});

export const initializeInput = Effect.fn("input.initialize")(function* (
  env: Env,
  sandboxId: string,
  id: string,
  initial: Uint8Array,
) {
  const current = yield* Effect.tryPromise({
    try: () => env.OBJECTS.head(`process-input/${sandboxId}/${id}.json`),
    catch: (cause) => new StorageFailure({ cause }),
  });
  if (current !== null) return;
  if (initial.byteLength > 1_048_576)
    return yield* new StorageFailure({ cause: "Oversized initial stdin" });
  const chunks: (typeof InputHead.Type.chunks)[number][] = [];
  for (const offset of Array.from(
    { length: Math.ceil(initial.byteLength / 65_536) },
    (_, index) => index * 65_536,
  )) {
    const bytes = initial.subarray(offset, offset + 65_536);
    const digest = yield* Effect.promise(() =>
      crypto.subtle.digest("SHA-256", Uint8Array.from(bytes)),
    );
    const hash = Buffer.from(digest).toString("hex");
    yield* Effect.tryPromise({
      try: () =>
        env.OBJECTS.put(`sandboxes/${sandboxId}/stdin/${hash}`, bytes, {
          onlyIf: { etagDoesNotMatch: "*" },
        }),
      catch: (cause) => new StorageFailure({ cause }),
    });
    chunks.push({ hash, size: bytes.byteLength });
  }
  yield* Effect.tryPromise({
    try: () =>
      env.OBJECTS.put(
        `process-input/${sandboxId}/${id}.json`,
        Schema.encodeSync(Schema.fromJsonString(InputHead))({
          version: 1,
          size: initial.byteLength,
          closed: false,
          chunks,
        }),
        { onlyIf: { etagDoesNotMatch: "*" } },
      ),
    catch: (cause) => new StorageFailure({ cause }),
  });
});

export const finishInput = Effect.fn("input.finish")(function* (
  env: Env,
  sandboxId: string,
  id: string,
) {
  for (const attempt of [0, 1, 2]) {
    const { input, etag } = yield* load(env, sandboxId, id);
    if (input.closed) return;
    const saved = yield* Effect.tryPromise({
      try: () =>
        env.OBJECTS.put(
          `process-input/${sandboxId}/${id}.json`,
          Schema.encodeSync(Schema.fromJsonString(InputHead))({ ...input, closed: true }),
          { onlyIf: { etagMatches: etag } },
        ),
      catch: (cause) => new StorageFailure({ cause }),
    });
    if (saved !== null) return;
    if (attempt === 2)
      return yield* new StorageFailure({
        cause: "Input closure conflicted with concurrent writers",
      });
  }
});

export const readInput = Effect.fn("input.read")(function* (
  env: Env,
  sandboxId: string,
  id: string,
  offset: number,
  length: number,
) {
  const { input } = yield* load(env, sandboxId, id);
  if (offset < 0 || offset > input.size || length < 1 || length > 65_536)
    return yield* new StorageFailure({ cause: "Invalid stdin read range" });
  const end = Math.min(offset + length, input.size);
  const data: Buffer[] = [];
  const position = { offset: 0 };
  for (const chunk of input.chunks) {
    const start = position.offset;
    position.offset += chunk.size;
    if (start >= end) break;
    if (position.offset <= offset) continue;
    const object = yield* Effect.tryPromise({
      try: () => env.OBJECTS.get(`sandboxes/${sandboxId}/stdin/${chunk.hash}`),
      catch: (cause) => new StorageFailure({ cause }),
    });
    if (object === null || object.size !== chunk.size)
      return yield* new StorageFailure({ cause: "Missing or invalid stdin block" });
    const bytes = yield* Effect.tryPromise({
      try: () => object.arrayBuffer(),
      catch: (cause) => new StorageFailure({ cause }),
    });
    const digest = yield* Effect.promise(() => crypto.subtle.digest("SHA-256", bytes));
    if (Buffer.from(digest).toString("hex") !== chunk.hash)
      return yield* new StorageFailure({ cause: "Stdin block digest mismatch" });
    data.push(
      Buffer.from(bytes).subarray(Math.max(offset - start, 0), Math.min(end - start, chunk.size)),
    );
  }
  return { data: Buffer.concat(data), closed: input.closed, total: input.size };
});

export const input = Effect.fn("process.input")(function* (
  env: Env,
  capability: typeof Capability.Type,
  action: typeof ProcessInputAction.Type,
) {
  yield* requirePermission(capability, "execute");
  yield* head(env, capability.sandboxId);
  const process = yield* Effect.tryPromise({
    try: () => env.OBJECTS.get(`processes/${capability.sandboxId}/${action.id}.json`),
    catch: (cause) => new StorageFailure({ cause }),
  });
  if (process === null)
    return yield* new Fault({ code: "ENOENT", status: 404, message: "Execution does not exist" });
  if (process.size > 8_388_608)
    return yield* new StorageFailure({ cause: "Oversized process receipt" });
  const text = yield* Effect.tryPromise({
    try: () => process.text(),
    catch: (cause) => new StorageFailure({ cause }),
  });
  const record = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(StoredRun))(text);
  if (record.stdinMode !== "pipe")
    return yield* new Fault({
      code: "EINVAL",
      status: 400,
      message: "Process stdin is not interactive",
    });
  const object = yield* Effect.tryPromise({
    try: () => env.OBJECTS.head(`process-input/${capability.sandboxId}/${action.id}.json`),
    catch: (cause) => new StorageFailure({ cause }),
  });
  if (object === null) {
    const program = yield* restore(env, capability.sandboxId, record.sourceHash);
    if (program.language !== "wasm")
      return yield* new StorageFailure({ cause: "Interactive process has a different runtime" });
    yield* initializeInput(
      env,
      capability.sandboxId,
      action.id,
      Buffer.from(program.stdin, "base64"),
    );
  }
  const { input: current, etag } = yield* load(env, capability.sandboxId, action.id);
  const closed = current.closed || (record.status !== "queued" && record.status !== "running");
  if (action.op === "process.stdin.status")
    return { offset: current.size, total: current.size, closed: current.closed };
  const bytes = yield* Effect.sync(() => {
    if (action.op === "process.stdin.write") return Buffer.from(action.content, action.encoding);
    return Buffer.alloc(0);
  });
  if (
    action.op === "process.stdin.write" &&
    (bytes.length < 1 ||
      bytes.length > 65_536 ||
      (action.encoding === "base64" && bytes.toString("base64") !== action.content))
  )
    return yield* new Fault({
      code: "EINVAL",
      status: 400,
      message: "Stdin writes require 1 to 65536 bytes and canonical encoding",
    });
  if (
    action.op === "process.stdin.write" &&
    action.offset < current.size &&
    action.offset + bytes.length <= current.size
  ) {
    const previous = yield* readInput(
      env,
      capability.sandboxId,
      action.id,
      action.offset,
      bytes.length,
    );
    if (previous.data.equals(bytes))
      return { offset: action.offset + bytes.length, total: current.size, closed };
  }
  if (action.offset !== current.size)
    return yield* new Fault({
      code: "CONFLICT",
      status: 409,
      message: "Stdin offset changed; inspect process.stdin.status",
    });
  if (closed) {
    if (action.op === "process.stdin.close")
      return { offset: current.size, total: current.size, closed: true };
    return yield* new Fault({ code: "EPIPE", status: 409, message: "Process stdin is closed" });
  }
  if (
    current.size + bytes.length > 16_777_216 ||
    (current.chunks.length >= 1024 && bytes.length > 0)
  )
    return yield* new Fault({
      code: "EFBIG",
      status: 413,
      message: "Interactive stdin exceeds its byte or chunk limit",
    });
  const updated = yield* Effect.gen(function* () {
    if (action.op === "process.stdin.close") return { ...current, closed: true };
    const digest = yield* Effect.promise(() =>
      crypto.subtle.digest("SHA-256", Uint8Array.from(bytes)),
    );
    const hash = Buffer.from(digest).toString("hex");
    yield* Effect.tryPromise({
      try: () =>
        env.OBJECTS.put(`sandboxes/${capability.sandboxId}/stdin/${hash}`, bytes, {
          onlyIf: { etagDoesNotMatch: "*" },
        }),
      catch: (cause) => new StorageFailure({ cause }),
    });
    return {
      ...current,
      size: current.size + bytes.length,
      chunks: [...current.chunks, { hash, size: bytes.length }],
    };
  });
  const now = yield* Clock.currentTimeMillis;
  if (capability.expiresAt <= now)
    return yield* new Fault({ code: "UNAUTHORIZED", status: 401, message: "Capability expired" });
  yield* head(env, capability.sandboxId);
  const saved = yield* Effect.tryPromise({
    try: () =>
      env.OBJECTS.put(
        `process-input/${capability.sandboxId}/${action.id}.json`,
        Schema.encodeSync(Schema.fromJsonString(InputHead))(updated),
        { onlyIf: { etagMatches: etag } },
      ),
    catch: (cause) => new StorageFailure({ cause }),
  });
  if (saved === null)
    return yield* new Fault({
      code: "CONFLICT",
      status: 409,
      message: "Concurrent stdin mutation; inspect process.stdin.status",
    });
  return { offset: updated.size, total: updated.size, closed: updated.closed };
});
