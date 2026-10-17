import { Effect, Schema } from "effect";
import wasm from "cirro:wasi";
import revision from "../dist/wasi/revision.json";
import { createBindings } from "../dist/wasi/bindings";
import { Fault, HeapSnapshot, ExecutionCheckpoint } from "./contracts";
import { StorageFailure } from "./storage";
import { saveMemoryPages, restoreMemoryPages } from "./memory";
import type { Env } from "./resources";

export const saveHeap = Effect.fn("checkpoint.saveHeap")(function* (
  objects: Env["OBJECTS"],
  sandboxId: string,
  memory: WebAssembly.Memory,
  handles: typeof HeapSnapshot.Type.handles,
) {
  if (
    new Set(handles.map((item) => item.pid)).size !== handles.length ||
    new Set(handles.map((item) => item.handle)).size !== handles.length ||
    !handles.some((item) => item.pid === 1)
  )
    return yield* new StorageFailure({ cause: "Checkpoint handles do not identify one family" });
  const { codec, memoryBytes, pages } = yield* saveMemoryPages(objects, sandboxId, memory);
  const snapshot = {
    version: 2 as const,
    runtime: revision.sha256,
    codec,
    memoryBytes,
    pages,
    handles,
  };
  const bytes = Buffer.from(Schema.encodeSync(Schema.fromJsonString(HeapSnapshot))(snapshot));
  const digest = yield* Effect.promise(() => crypto.subtle.digest("SHA-256", bytes));
  const hash = Buffer.from(digest).toString("hex");
  yield* Effect.tryPromise({
    try: () =>
      objects.put(`sandboxes/${sandboxId}/checkpoints/${hash}.json`, bytes, {
        onlyIf: { etagDoesNotMatch: "*" },
      }),
    catch: (cause) => new StorageFailure({ cause }),
  });
  return hash;
});

export const restoreHeap = Effect.fn("checkpoint.restoreHeap")(function* (
  objects: Env["OBJECTS"],
  sandboxId: string,
  hash: string,
) {
  const object = yield* Effect.tryPromise({
    try: () => objects.get(`sandboxes/${sandboxId}/checkpoints/${hash}.json`),
    catch: (cause) => new StorageFailure({ cause }),
  });
  if (object === null || object.size > 131_072)
    return yield* new StorageFailure({ cause: "Missing or oversized checkpoint" });
  const bytes = yield* Effect.tryPromise({
    try: () => object.arrayBuffer(),
    catch: (cause) => new StorageFailure({ cause }),
  });
  const digest = yield* Effect.promise(() => crypto.subtle.digest("SHA-256", bytes));
  if (Buffer.from(digest).toString("hex") !== hash)
    return yield* new StorageFailure({ cause: "Checkpoint manifest digest mismatch" });
  const snapshot = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(HeapSnapshot))(
    Buffer.from(bytes).toString(),
  );
  if (snapshot.runtime !== revision.sha256)
    return yield* new Fault({
      code: "CHECKPOINT_RUNTIME_MISMATCH",
      status: 409,
      message: "Checkpoint uses another Rust runtime",
    });
  if (
    new Set(snapshot.handles.map((item) => item.pid)).size !== snapshot.handles.length ||
    new Set(snapshot.handles.map((item) => item.handle)).size !== snapshot.handles.length ||
    !snapshot.handles.some((item) => item.pid === 1)
  )
    return yield* new StorageFailure({ cause: "Invalid checkpoint page or handle layout" });
  const bindings = createBindings();
  const exports = bindings.initSync({ module: wasm });
  yield* restoreMemoryPages(objects, sandboxId, exports.memory, snapshot);
  return { bindings, exports, handles: snapshot.handles };
});

export class CheckpointReady extends Schema.TaggedError<CheckpointReady>()("CheckpointReady", {
  reference: Schema.String,
}) {}
export const saveExecutionCheckpoint = Effect.fn("checkpoint.saveExecution")(function* (
  objects: Env["OBJECTS"],
  sandboxId: string,
  checkpoint: typeof ExecutionCheckpoint.Type,
) {
  const bytes = Buffer.from(
    Schema.encodeSync(Schema.fromJsonString(ExecutionCheckpoint))(checkpoint),
  );
  if (bytes.length > 16_777_216)
    return yield* new StorageFailure({ cause: "Execution checkpoint exceeds its metadata limit" });
  const digest = yield* Effect.promise(() => crypto.subtle.digest("SHA-256", bytes));
  const hash = Buffer.from(digest).toString("hex");
  yield* Effect.tryPromise({
    try: () =>
      objects.put(`sandboxes/${sandboxId}/execution-checkpoints/${hash}.json`, bytes, {
        onlyIf: { etagDoesNotMatch: "*" },
      }),
    catch: (cause) => new StorageFailure({ cause }),
  });
  return hash;
});
export class CheckpointVersionPending extends Schema.TaggedError<CheckpointVersionPending>()(
  "CheckpointVersionPending",
  {},
) {}
const CheckpointVersion = Schema.Struct({
  version: Schema.Int,
  head: Schema.Struct({ version: Schema.Int }),
});
export const restoreExecutionCheckpoint = Effect.fn("checkpoint.restoreExecution")(function* (
  objects: Env["OBJECTS"],
  sandboxId: string,
  hash: string,
) {
  const object = yield* Effect.tryPromise({
    try: () => objects.get(`sandboxes/${sandboxId}/execution-checkpoints/${hash}.json`),
    catch: (cause) => new StorageFailure({ cause }),
  });
  if (object === null || object.size > 16_777_216)
    return yield* new StorageFailure({ cause: "Missing or oversized execution checkpoint" });
  const bytes = yield* Effect.tryPromise({
    try: () => object.arrayBuffer(),
    catch: (cause) => new StorageFailure({ cause }),
  });
  const digest = yield* Effect.promise(() => crypto.subtle.digest("SHA-256", bytes));
  if (Buffer.from(digest).toString("hex") !== hash)
    return yield* new StorageFailure({ cause: "Execution checkpoint digest mismatch" });
  const text = Buffer.from(bytes).toString();
  const header = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(CheckpointVersion))(text);
  if (header.head.version !== 3 || header.version !== 2)
    return yield* new CheckpointVersionPending({});
  return yield* Schema.decodeUnknownEffect(Schema.fromJsonString(ExecutionCheckpoint))(text);
});
