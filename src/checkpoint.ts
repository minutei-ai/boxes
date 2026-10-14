import { Effect, Schema } from "effect";
import wasm from "cirro:wasi";
import revision from "../dist/wasi/revision.json";
import { createBindings } from "../dist/wasi/bindings";
import { Fault, HeapSnapshot } from "./contracts";
import { StorageFailure } from "./storage";
import type { Env } from "./resources";

export const saveHeap = Effect.fn("checkpoint.saveHeap")(function* (
  objects: Env["OBJECTS"],
  sandboxId: string,
  memory: WebAssembly.Memory,
  handles: typeof HeapSnapshot.Type.handles,
) {
  const memoryBytes = memory.buffer.byteLength;
  if (memoryBytes < 65_536 || memoryBytes > 67_108_864 || memoryBytes % 65_536 !== 0)
    return yield* new StorageFailure({ cause: "Rust heap exceeds checkpoint limits" });
  if (
    new Set(handles.map((item) => item.pid)).size !== handles.length ||
    new Set(handles.map((item) => item.handle)).size !== handles.length ||
    !handles.some((item) => item.pid === 1)
  )
    return yield* new StorageFailure({ cause: "Checkpoint handles do not identify one family" });
  const uploaded = new Set<string>();
  const pages = yield* Effect.forEach(
    Array.from({ length: memoryBytes / 65_536 }, (_, index) => index),
    (index) =>
      Effect.gen(function* () {
        const bytes = Uint8Array.from(new Uint8Array(memory.buffer, index * 65_536, 65_536));
        const digest = yield* Effect.promise(() => crypto.subtle.digest("SHA-256", bytes));
        const hash = Buffer.from(digest).toString("hex");
        if (uploaded.has(hash)) return hash;
        uploaded.add(hash);
        yield* Effect.tryPromise({
          try: () =>
            objects.put(`sandboxes/${sandboxId}/checkpoint-pages/${hash}`, bytes, {
              onlyIf: { etagDoesNotMatch: "*" },
            }),
          catch: (cause) => new StorageFailure({ cause }),
        });
        return hash;
      }),
    { concurrency: 4 },
  );
  const snapshot = { version: 1 as const, runtime: revision.sha256, memoryBytes, pages, handles };
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
    snapshot.memoryBytes % 65_536 !== 0 ||
    snapshot.pages.length !== snapshot.memoryBytes / 65_536 ||
    new Set(snapshot.handles.map((item) => item.pid)).size !== snapshot.handles.length ||
    new Set(snapshot.handles.map((item) => item.handle)).size !== snapshot.handles.length ||
    !snapshot.handles.some((item) => item.pid === 1)
  )
    return yield* new StorageFailure({ cause: "Invalid checkpoint page or handle layout" });
  const bindings = createBindings();
  const exports = bindings.initSync({ module: wasm });
  const additional = snapshot.memoryBytes / 65_536 - exports.memory.buffer.byteLength / 65_536;
  if (additional < 0)
    return yield* new StorageFailure({ cause: "Checkpoint is smaller than its runtime memory" });
  if (additional > 0)
    yield* Effect.try({
      try: () => exports.memory.grow(additional),
      catch: (cause) => new StorageFailure({ cause }),
    });
  yield* Effect.forEach(
    Array.from(snapshot.pages.entries()),
    ([index, hash]) =>
      Effect.gen(function* () {
        const page = yield* Effect.tryPromise({
          try: () => objects.get(`sandboxes/${sandboxId}/checkpoint-pages/${hash}`),
          catch: (cause) => new StorageFailure({ cause }),
        });
        if (page === null || page.size !== 65_536)
          return yield* new StorageFailure({ cause: "Missing or oversized checkpoint page" });
        const bytes = yield* Effect.tryPromise({
          try: () => page.arrayBuffer(),
          catch: (cause) => new StorageFailure({ cause }),
        });
        const digest = yield* Effect.promise(() => crypto.subtle.digest("SHA-256", bytes));
        if (Buffer.from(digest).toString("hex") !== hash)
          return yield* new StorageFailure({ cause: "Checkpoint page digest mismatch" });
        new Uint8Array(exports.memory.buffer, index * 65_536, 65_536).set(new Uint8Array(bytes));
      }),
    { concurrency: 4, discard: true },
  );
  return { bindings, exports, handles: snapshot.handles };
});
