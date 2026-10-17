import { expect, test } from "bun:test";
import { Effect } from "effect";
import { initSync, pack_memory, unpack_memory } from "../dist/kernel/cirro_kernel";

const module = new WebAssembly.Module(
  await Bun.file(new URL("../dist/kernel/cirro_kernel_bg.wasm", import.meta.url)).arrayBuffer(),
);
initSync({ module });

test("compiled Rust memory packs interoperate with native zlib streams at the maximum pack size", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const bytes = Uint8Array.from(
        { length: 1_048_576 },
        (_, index) => (index * 31 + Math.floor(index / 256)) % 256,
      );
      const encoded = pack_memory(bytes);
      const decoded = yield* Effect.promise(() =>
        new Response(
          new Blob([Uint8Array.from(encoded)])
            .stream()
            .pipeThrough(new DecompressionStream("deflate")),
        ).arrayBuffer(),
      );
      expect(new Uint8Array(decoded)).toEqual(bytes);
      const native = yield* Effect.promise(() =>
        new Response(
          new Blob([bytes]).stream().pipeThrough(new CompressionStream("deflate")),
        ).arrayBuffer(),
      );
      expect(unpack_memory(new Uint8Array(native), bytes.length)).toEqual(bytes);
    }),
  ));

test("compiled Rust inflation rejects oversized output and trailing input before returning guest memory", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const bytes = new Uint8Array(4_194_304);
      const bomb = yield* Effect.promise(() =>
        new Response(
          new Blob([bytes]).stream().pipeThrough(new CompressionStream("deflate")),
        ).arrayBuffer(),
      );
      expect(() => unpack_memory(new Uint8Array(bomb), 1_048_576)).toThrow();
      const encoded = pack_memory(new Uint8Array(65_536));
      expect(() => unpack_memory(encoded, 131_072)).toThrow();
      const trailing = new Uint8Array(encoded.length + 1);
      trailing.set(encoded);
      expect(() => unpack_memory(trailing, 65_536)).toThrow();
      expect(() => pack_memory(new Uint8Array(65_537))).toThrow();
      expect(unpack_memory(encoded, 65_536)).toEqual(new Uint8Array(65_536));
    }),
  ));
