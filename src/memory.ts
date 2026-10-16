import { Effect } from "effect";
import { MemoryPages } from "./contracts";
import { StorageFailure } from "./storage";
import type { Env } from "./resources";

export const saveMemoryPages = Effect.fn("memory.savePages")(function* (
  objects: Env["OBJECTS"],
  sandboxId: string,
  memory: WebAssembly.Memory,
  previous: typeof MemoryPages.Type.pages = [],
) {
  const memoryBytes = memory.buffer.byteLength;
  if (memoryBytes < 65_536 || memoryBytes > 67_108_864 || memoryBytes % 65_536 !== 0)
    return yield* new StorageFailure({ cause: "Rust heap exceeds checkpoint limits" });
  const retained = new Set(previous);
  const uploaded = new Set<string>();
  const pages = yield* Effect.forEach(
    Array.from({ length: memoryBytes / 65_536 }, (_, index) => index),
    (index) =>
      Effect.gen(function* () {
        const bytes = Uint8Array.from(new Uint8Array(memory.buffer, index * 65_536, 65_536));
        const digest = yield* Effect.promise(() => crypto.subtle.digest("SHA-256", bytes));
        const hash = Buffer.from(digest).toString("hex");
        if (retained.has(hash) || uploaded.has(hash)) return hash;
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
  return { memoryBytes, pages, pageWrites: uploaded.size };
});

export const restoreMemoryPages = Effect.fn("memory.restorePages")(function* (
  objects: Env["OBJECTS"],
  sandboxId: string,
  memory: WebAssembly.Memory,
  snapshot: typeof MemoryPages.Type,
) {
  if (
    snapshot.memoryBytes < 65_536 ||
    snapshot.memoryBytes > 67_108_864 ||
    snapshot.memoryBytes % 65_536 !== 0 ||
    snapshot.pages.length !== snapshot.memoryBytes / 65_536
  )
    return yield* new StorageFailure({ cause: "Invalid checkpoint page layout" });
  const additional = snapshot.memoryBytes / 65_536 - memory.buffer.byteLength / 65_536;
  if (additional < 0)
    return yield* new StorageFailure({ cause: "Checkpoint is smaller than its runtime memory" });
  if (additional > 0)
    yield* Effect.try({
      try: () => memory.grow(additional),
      catch: (cause) => new StorageFailure({ cause }),
    });
  const pages = Map.groupBy(snapshot.pages.keys(), (index) => snapshot.pages[index]);
  yield* Effect.forEach(
    pages,
    ([hash, indices]) =>
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
        for (const index of indices)
          new Uint8Array(memory.buffer, index * 65_536, 65_536).set(new Uint8Array(bytes));
      }),
    { concurrency: 4, discard: true },
  );
});
