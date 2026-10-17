import { Effect, Schema } from "effect";
import wasm from "cirro:wasm";
import { initSync, pack_memory, unpack_memory } from "../dist/kernel/cirro_kernel";
import {
  checkpointMemoryCodec,
  checkpointPackPages,
  checkpointPageLimit,
  MemoryPages,
} from "./contracts";
import { StorageFailure } from "./storage";
import type { Env } from "./resources";

initSync({ module: wasm });

export const memoryPackPlan = Effect.fn("memory.packPlan")(function* (
  pages: typeof MemoryPages.Type.pages,
) {
  const groups = Map.groupBy(
    Array.from({ length: Math.ceil(pages.length / checkpointPackPages) }, (_, index) => ({
      start: index * checkpointPackPages,
      hashes: pages.slice(index * checkpointPackPages, (index + 1) * checkpointPackPages),
    })),
    (pack) => pack.hashes.join(""),
  );
  return yield* Effect.forEach(
    groups,
    ([identity, packs]) =>
      Effect.gen(function* () {
        const first = packs[0];
        if (first === undefined)
          return yield* new StorageFailure({ cause: "Empty checkpoint pack" });
        const digest = yield* Effect.promise(() =>
          crypto.subtle.digest(
            "SHA-256",
            new TextEncoder().encode(`${checkpointMemoryCodec}:${identity}`),
          ),
        );
        return {
          hash: Buffer.from(digest).toString("hex"),
          hashes: first.hashes,
          starts: packs.map((pack) => pack.start),
        };
      }),
    { concurrency: 4 },
  );
});

export const saveMemoryPages = Effect.fn("memory.savePages")(function* (
  objects: Env["OBJECTS"],
  sandboxId: string,
  memory: WebAssembly.Memory,
  previous: typeof MemoryPages.Type.pages = [],
) {
  const memoryBytes = memory.buffer.byteLength;
  if (
    memoryBytes < 65_536 ||
    memoryBytes > checkpointPageLimit * 65_536 ||
    memoryBytes % 65_536 !== 0
  )
    return yield* new StorageFailure({ cause: "Rust heap exceeds checkpoint limits" });
  const pages: typeof MemoryPages.Type.pages = yield* Effect.forEach(
    Array.from({ length: memoryBytes / 65_536 }, (_, index) => index),
    (index) =>
      Effect.gen(function* () {
        const bytes = Uint8Array.from(new Uint8Array(memory.buffer, index * 65_536, 65_536));
        const digest = yield* Effect.promise(() => crypto.subtle.digest("SHA-256", bytes));
        const hash = Buffer.from(digest).toString("hex");
        return hash;
      }),
    { concurrency: 4 },
  );
  const retained = new Set((yield* memoryPackPlan(previous)).map((pack) => pack.hash));
  const uploaded = new Set<string>();
  const packs = yield* memoryPackPlan(pages);
  yield* Effect.forEach(
    packs,
    (pack) =>
      Effect.gen(function* () {
        if (retained.has(pack.hash)) return;
        const bytes = yield* Effect.try({
          try: () =>
            Uint8Array.from(
              pack_memory(
                Uint8Array.from(
                  new Uint8Array(
                    memory.buffer,
                    pack.starts[0] * 65_536,
                    pack.hashes.length * 65_536,
                  ),
                ),
              ),
            ),
          catch: (cause) => new StorageFailure({ cause }),
        });
        yield* Effect.tryPromise({
          try: () =>
            objects.put(`sandboxes/${sandboxId}/checkpoint-packs/${pack.hash}`, bytes, {
              onlyIf: { etagDoesNotMatch: "*" },
            }),
          catch: (cause) => new StorageFailure({ cause }),
        });
        uploaded.add(pack.hash);
      }),
    { concurrency: 4, discard: true },
  );
  return {
    codec: checkpointMemoryCodec,
    memoryBytes,
    pages,
    packs: packs.length,
    puts: uploaded.size,
  } as const;
});

export const restoreMemoryPages = Effect.fn("memory.restorePages")(function* (
  objects: Env["OBJECTS"],
  sandboxId: string,
  memory: WebAssembly.Memory,
  snapshot: typeof MemoryPages.Type,
) {
  if (!Schema.is(MemoryPages)(snapshot))
    return yield* new StorageFailure({ cause: "Invalid checkpoint page layout" });
  const additional = snapshot.memoryBytes / 65_536 - memory.buffer.byteLength / 65_536;
  if (additional < 0)
    return yield* new StorageFailure({ cause: "Checkpoint is smaller than its runtime memory" });
  if (additional > 0)
    yield* Effect.try({
      try: () => memory.grow(additional),
      catch: (cause) => new StorageFailure({ cause }),
    });
  yield* Effect.forEach(
    yield* memoryPackPlan(snapshot.pages),
    (pack) =>
      Effect.gen(function* () {
        const page = yield* Effect.tryPromise({
          try: () => objects.get(`sandboxes/${sandboxId}/checkpoint-packs/${pack.hash}`),
          catch: (cause) => new StorageFailure({ cause }),
        });
        const rawBytes = pack.hashes.length * 65_536;
        if (page === null || page.size === 0 || page.size > rawBytes + rawBytes / 128 + 64)
          return yield* new StorageFailure({ cause: "Missing or oversized checkpoint pack" });
        const encoded = yield* Effect.tryPromise({
          try: () => page.arrayBuffer(),
          catch: (cause) => new StorageFailure({ cause }),
        });
        const bytes = yield* Effect.try({
          try: () => Uint8Array.from(unpack_memory(new Uint8Array(encoded), rawBytes)),
          catch: (cause) => new StorageFailure({ cause }),
        });
        for (const [index, expected] of pack.hashes.entries()) {
          const actual = yield* Effect.promise(() =>
            crypto.subtle.digest("SHA-256", bytes.subarray(index * 65_536, (index + 1) * 65_536)),
          );
          if (Buffer.from(actual).toString("hex") !== expected)
            return yield* new StorageFailure({ cause: "Checkpoint page digest mismatch" });
        }
        for (const start of pack.starts)
          new Uint8Array(memory.buffer, start * 65_536, rawBytes).set(bytes);
      }),
    { concurrency: 4, discard: true },
  );
});
