import { Effect } from "effect";
import { initSync, unpack_memory } from "../../dist/kernel/cirro_kernel";
import { MemoryPages, checkpointMemoryCodec, checkpointPackPages } from "../../src/contracts";
import type { Env } from "../../src/resources";

initSync({
  module: new WebAssembly.Module(
    await Bun.file(
      new URL("../../dist/kernel/cirro_kernel_bg.wasm", import.meta.url),
    ).arrayBuffer(),
  ),
});

export const writeLegacyMemory = Effect.fn("migrationFixture.writeLegacyMemory")(function* (
  objects: Env["OBJECTS"],
  sandboxId: string,
  snapshot: typeof MemoryPages.Type,
) {
  for (const start of Array.from(
    { length: Math.ceil(snapshot.pages.length / checkpointPackPages) },
    (_, index) => index * checkpointPackPages,
  )) {
    const hashes = snapshot.pages.slice(start, start + checkpointPackPages);
    const hash = Buffer.from(
      yield* Effect.promise(() =>
        crypto.subtle.digest(
          "SHA-256",
          new TextEncoder().encode(`${checkpointMemoryCodec}:${hashes.join("")}`),
        ),
      ),
    ).toString("hex");
    const pack = yield* Effect.promise(() =>
      objects.get(`sandboxes/${sandboxId}/checkpoint-packs/${hash}`),
    );
    if (pack === null) return yield* Effect.die("Missing captured native heap pack");
    const bytes = unpack_memory(
      new Uint8Array(yield* Effect.promise(() => pack.arrayBuffer())),
      hashes.length * 65536,
    );
    for (const [index, pageHash] of hashes.entries()) {
      const page = Uint8Array.from(bytes.subarray(index * 65536, (index + 1) * 65536));
      const digest = Buffer.from(
        yield* Effect.promise(() => crypto.subtle.digest("SHA-256", page)),
      ).toString("hex");
      if (digest !== pageHash)
        return yield* Effect.die("Captured native heap page digest mismatch");
      yield* Effect.promise(() =>
        objects.put(`sandboxes/${sandboxId}/checkpoint-pages/${pageHash}`, page, {
          onlyIf: { etagDoesNotMatch: "*" },
        }),
      );
    }
  }
});
