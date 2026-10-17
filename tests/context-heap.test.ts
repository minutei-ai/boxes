import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Schema } from "effect";
import { checkpointMemoryCodec, checkpointPackPages, ErrorResponse } from "../src/contracts";
import { initSync, pack_memory, unpack_memory } from "../dist/kernel/cirro_kernel";

import { runtime } from "../tooling/worker-test";
import {
  ContextCheckpointRequest,
  ContextCheckpointProof,
  ContextMemory,
} from "./fixtures/context-checkpoint-contract";

initSync({
  module: new WebAssembly.Module(
    await Bun.file(new URL("../dist/kernel/cirro_kernel_bg.wasm", import.meta.url)).arrayBuffer(),
  ),
});

test(
  "R2 restores a QuickJS closure and pending promise after the original Worker closes",
  () =>
    Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const directory = yield* Effect.acquireRelease(
            Effect.promise(() => mkdtemp(join(tmpdir(), "boxes-context-heap-"))),
            (path) => Effect.promise(() => rm(path, { recursive: true, force: true })),
          );
          const saved = yield* Effect.scoped(
            Effect.gen(function* () {
              const first = yield* Effect.acquireRelease(
                Effect.sync(() => runtime(directory, { artifact: "context-checkpoint-worker" })),
                (worker) => Effect.promise(() => worker.dispose()),
              );
              const url = yield* Effect.promise(() => first.ready);
              const response = yield* Effect.promise(() =>
                fetch(url, {
                  method: "POST",
                  headers: { "content-type": "application/json" },
                  body: Schema.encodeSync(Schema.fromJsonString(ContextCheckpointRequest))({
                    op: "save",
                    program: {
                      language: "javascript",
                      env: {},
                      entry: "/main.js",
                      mode: "function",
                      modules: [
                        {
                          name: "/main.js",
                          source:
                            "export default async ({tools,console}) => { console.log('entered'); globalThis.counter = 40; const increment = () => ++globalThis.counter; const reply = await tools.call({op:'host.call',name:'echo',input:2}); console.log('restored'); return increment() + reply; }",
                          imports: [],
                        },
                      ],
                    },
                  }),
                }),
              );
              expect(response.status).toBe(200);
              return yield* Schema.decodeUnknownEffect(
                Schema.fromJsonString(ContextCheckpointProof),
              )(yield* Effect.promise(() => response.text()));
            }),
          );
          expect(saved.op).toBe("saved");
          if (saved.op !== "saved") return yield* Effect.die("Native context was not saved");
          expect(saved.request).toEqual({ op: "host.call", name: "echo", input: 2 });
          const reply = yield* Schema.decodeUnknownEffect(Schema.Number)(saved.request.input);
          const second = yield* Effect.acquireRelease(
            Effect.sync(() => runtime(directory, { artifact: "context-checkpoint-worker" })),
            (worker) => Effect.promise(() => worker.dispose()),
          );
          const url = yield* Effect.promise(() => second.ready);
          const resumed = yield* Effect.promise(() =>
            fetch(url, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: Schema.encodeSync(Schema.fromJsonString(ContextCheckpointRequest))({
                op: "resume",
                hash: saved.hash,
                reply,
              }),
            }),
          );
          expect(resumed.status).toBe(200);
          const result = yield* Schema.decodeUnknownEffect(
            Schema.fromJsonString(ContextCheckpointProof),
          )(yield* Effect.promise(() => resumed.text()));
          expect(result.op).toBe("resumed");
          if (result.op !== "resumed") return yield* Effect.die("Native context did not resume");
          expect(result.output).toEqual({
            stdout: "entered\nrestored\n",
            stderr: "",
            result: 43,
            exitCode: 0,
          });
          const objects = yield* Effect.promise(() => second.objects);
          const manifest = yield* Effect.promise(() =>
            objects.get(`context-heap/${saved.hash}.json`),
          );
          if (manifest === null) return yield* Effect.die("Missing native R2 context manifest");
          const metadata = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(ContextMemory))(
            yield* Effect.promise(() => manifest.text()),
          );
          const identity = metadata.pages.slice(0, checkpointPackPages).join("");
          const packHash = Buffer.from(
            yield* Effect.promise(() =>
              crypto.subtle.digest(
                "SHA-256",
                new TextEncoder().encode(`${checkpointMemoryCodec}:${identity}`),
              ),
            ),
          ).toString("hex");
          const packKey = `sandboxes/context-heap-proof/checkpoint-packs/${packHash}`;
          const blob = yield* Effect.promise(() => objects.get(packKey));
          if (blob === null) return yield* Effect.die("Missing native R2 context image");
          const original = yield* Effect.promise(() => blob.arrayBuffer());
          const raw = Uint8Array.from(
            unpack_memory(
              new Uint8Array(original),
              Math.min(metadata.pages.length, checkpointPackPages) * 65536,
            ),
          );
          raw[raw.byteLength - 1] ^= 1;
          const corrupt = Uint8Array.from(pack_memory(raw));
          yield* Effect.promise(() => objects.put(packKey, corrupt));
          const rejected = yield* Effect.promise(() =>
            fetch(url, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: Schema.encodeSync(Schema.fromJsonString(ContextCheckpointRequest))({
                op: "resume",
                hash: saved.hash,
                reply,
              }),
            }),
          );
          expect(rejected.status).toBe(500);
          expect(
            yield* Schema.decodeUnknownEffect(Schema.fromJsonString(ErrorResponse))(
              yield* Effect.promise(() => rejected.text()),
            ),
          ).toEqual({ error: "STORAGE_FAILURE", message: "Context checkpoint validation failed" });
          yield* Effect.promise(() => objects.put(packKey, original));
          const changed = Schema.encodeSync(Schema.fromJsonString(ContextMemory))({
            ...metadata,
            runtime: "0".repeat(64),
          });
          const changedHash = Buffer.from(
            yield* Effect.promise(() =>
              crypto.subtle.digest("SHA-256", new TextEncoder().encode(changed)),
            ),
          ).toString("hex");
          yield* Effect.promise(() => objects.put(`context-heap/${changedHash}.json`, changed));
          const mismatch = yield* Effect.promise(() =>
            fetch(url, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: Schema.encodeSync(Schema.fromJsonString(ContextCheckpointRequest))({
                op: "resume",
                hash: changedHash,
                reply,
              }),
            }),
          );
          expect(mismatch.status).toBe(409);
          expect(
            yield* Schema.decodeUnknownEffect(Schema.fromJsonString(ErrorResponse))(
              yield* Effect.promise(() => mismatch.text()),
            ),
          ).toEqual({
            error: "CHECKPOINT_RUNTIME_MISMATCH",
            message: "Context uses another Rust runtime",
          });
          const reused = yield* Effect.promise(() =>
            fetch(url, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: Schema.encodeSync(Schema.fromJsonString(ContextCheckpointRequest))({
                op: "save-reused",
                program: {
                  language: "javascript",
                  env: {},
                  entry: "/main.js",
                  mode: "function",
                  modules: [{ name: "/main.js", source: "export default () => 1", imports: [] }],
                },
              }),
            }),
          );
          expect(reused.status).toBe(200);
          expect(
            yield* Schema.decodeUnknownEffect(Schema.fromJsonString(ContextCheckpointProof))(
              yield* Effect.promise(() => reused.text()),
            ),
          ).toEqual({
            op: "isolation-denied",
            message: "Context snapshot requires a fresh isolated runtime",
          });
        }),
      ),
    ),
  15000,
);

const transferContext = Effect.fn("contextTest.transfer")(function* (
  directory: string,
  input: typeof ContextCheckpointRequest.Type,
) {
  return yield* Effect.scoped(
    Effect.gen(function* () {
      const worker = yield* Effect.acquireRelease(
        Effect.sync(() => runtime(directory, { artifact: "context-checkpoint-worker" })),
        (worker) => Effect.promise(() => worker.dispose()),
      );
      const url = yield* Effect.promise(() => worker.ready);
      const response = yield* Effect.promise(() =>
        fetch(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: Schema.encodeSync(Schema.fromJsonString(ContextCheckpointRequest))(input),
        }),
      );
      expect(response.status).toBe(200);
      const proof = yield* Schema.decodeUnknownEffect(
        Schema.fromJsonString(ContextCheckpointProof),
      )(yield* Effect.promise(() => response.text()));
      if (!("hash" in proof)) return yield* Effect.die("Expected a saved context image");
      const objects = yield* Effect.promise(() => worker.objects);
      const manifest = yield* Effect.promise(() => objects.get(`context-heap/${proof.hash}.json`));
      if (manifest === null) return yield* Effect.die("Missing saved context manifest");
      const snapshot = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(ContextMemory))(
        yield* Effect.promise(() => manifest.text()),
      );
      const inventory = yield* Effect.promise(() =>
        objects.list({ prefix: "sandboxes/context-heap-proof/checkpoint-packs/", limit: 1000 }),
      );
      expect(inventory.truncated).toBe(false);
      const manifests = yield* Effect.promise(() =>
        objects.list({ prefix: "context-heap/", limit: 1000 }),
      );
      expect(manifests.truncated).toBe(false);
      expect(manifests.objects.every((object) => object.key.endsWith(".json"))).toBe(true);
      return { ...proof, snapshot, storedPacks: inventory.objects.length };
    }),
  );
});

test(
  "three Workers retain the actual lexical closure across reentry and a second R2 heap transfer",
  () =>
    Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const directory = yield* Effect.acquireRelease(
            Effect.promise(() => mkdtemp(join(tmpdir(), "boxes-context-reentry-"))),
            (path) => Effect.promise(() => rm(path, { recursive: true, force: true })),
          );
          const saved = yield* transferContext(directory, {
            op: "save",
            program: {
              language: "javascript",
              env: { ROUND: "first" },
              entry: "/tmp/repeated.js",
              mode: "function",
              modules: [
                {
                  name: "/tmp/repeated.js",
                  imports: [],
                  source:
                    "export default async ({tools,console}) => { console.log(process.env.ROUND); let value = 40; globalThis.next = () => { console.log('closure'); return ++value; }; const reply = await tools.call({op:'host.call',name:'echo',input:2}); return globalThis.next() + reply; }",
                },
              ],
            },
          });
          if (saved.op !== "saved") return yield* Effect.die("Initial context was not saved");
          expect(saved.request).toEqual({ op: "host.call", name: "echo", input: 2 });
          const firstPages = new Set(saved.snapshot.pages);
          expect(saved.storage.uniquePages).toBe(firstPages.size);
          expect(saved.storage.puts).toBe(saved.storage.packs);
          expect(saved.storedPacks).toBe(saved.storage.packs);
          expect(saved.storage.uniquePages).toBeLessThan(saved.storage.pages);
          const second = yield* transferContext(directory, {
            op: "reenter",
            hash: saved.hash,
            reply: 2,
            program: {
              language: "javascript",
              env: { ROUND: "second" },
              entry: "/tmp/repeated.js",
              mode: "function",
              modules: [
                {
                  name: "/tmp/repeated.js",
                  imports: [],
                  source:
                    "export default ({console}) => { console.log(process.env.ROUND); return {answer:globalThis.next(),round:'second',filename:import.meta.filename,url:import.meta.url}; }",
                },
              ],
            },
          });
          if (second.op !== "reentered")
            return yield* Effect.die("Second execution did not complete");
          expect(second.previous).toEqual({
            stdout: "first\nclosure\n",
            stderr: "",
            result: 43,
            exitCode: 0,
          });
          expect(second.output).toEqual({
            stdout: "second\nclosure\n",
            stderr: "",
            result: {
              answer: 42,
              round: "second",
              filename: "/tmp/repeated.js",
              url: "file:///tmp/repeated.js",
            },
            exitCode: 0,
          });
          expect(second.hash).not.toBe(saved.hash);
          const secondPages = new Set(second.snapshot.pages);
          expect(second.storage.uniquePages).toBe(secondPages.size);
          expect(Array.from(secondPages).some((hash) => firstPages.has(hash))).toBe(true);
          expect(second.storage.puts).toBeGreaterThan(0);
          expect(second.storage.puts).toBeLessThanOrEqual(second.storage.packs);
          expect(second.storage.puts).toBeLessThan(second.storage.uniquePages);
          expect(second.storedPacks).toBe(saved.storedPacks + second.storage.puts);
          const third = yield* transferContext(directory, {
            op: "continue",
            hash: second.hash,
            program: {
              language: "javascript",
              env: { ROUND: "third" },
              entry: "/tmp/repeated.js",
              mode: "function",
              modules: [
                {
                  name: "/tmp/repeated.js",
                  imports: [],
                  source:
                    "export default ({console}) => { console.log(process.env.ROUND); return {answer:globalThis.next(),round:'third',filename:import.meta.filename,url:import.meta.url}; }",
                },
              ],
            },
          });
          if (third.op !== "continued")
            return yield* Effect.die("Third execution did not complete");
          expect(third.output).toEqual({
            stdout: "third\nclosure\n",
            stderr: "",
            result: {
              answer: 43,
              round: "third",
              filename: "/tmp/repeated.js",
              url: "file:///tmp/repeated.js",
            },
            exitCode: 0,
          });
          expect(third.hash).not.toBe(second.hash);
          const thirdPages = new Set(third.snapshot.pages);
          expect(third.storage.uniquePages).toBe(thirdPages.size);
          expect(Array.from(thirdPages).some((hash) => secondPages.has(hash))).toBe(true);
          expect(third.storage.puts).toBeGreaterThan(0);
          expect(third.storage.puts).toBeLessThanOrEqual(third.storage.packs);
          expect(third.storage.puts).toBeLessThan(third.storage.uniquePages);
          expect(third.storedPacks).toBe(second.storedPacks + third.storage.puts);
        }),
      ),
    ),
  15000,
);

test(
  "native R2 pages deduplicate equal content, skip unchanged uploads and reject invalid layouts",
  () =>
    Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const directory = yield* Effect.acquireRelease(
            Effect.promise(() => mkdtemp(join(tmpdir(), "boxes-native-pages-"))),
            (path) => Effect.promise(() => rm(path, { recursive: true, force: true })),
          );
          const worker = yield* Effect.acquireRelease(
            Effect.sync(() => runtime(directory, { artifact: "context-checkpoint-worker" })),
            (worker) => Effect.promise(() => worker.dispose()),
          );
          const url = yield* Effect.promise(() => worker.ready);
          const response = yield* Effect.promise(() =>
            fetch(url, {
              method: "POST",
              body: Schema.encodeSync(Schema.fromJsonString(ContextCheckpointRequest))({
                op: "pages",
              }),
            }),
          );
          expect(response.status).toBe(200);
          const proof = yield* Schema.decodeUnknownEffect(
            Schema.fromJsonString(ContextCheckpointProof),
          )(yield* Effect.promise(() => response.text()));
          if (proof.op !== "pages") return yield* Effect.die("Missing native page proof");
          expect(proof.first).toEqual({ pages: 3, uniquePages: 1, packs: 1, puts: 1 });
          expect(proof.unchanged).toEqual({ pages: 3, uniquePages: 1, packs: 1, puts: 0 });
          expect(proof.changed).toEqual({ pages: 3, uniquePages: 2, packs: 1, puts: 1 });
          expect(proof.restoredBytes).toEqual([0, 0, 42]);
          expect(proof.storedPacks).toBe(2);
          expect(proof.rejectedLayouts).toEqual(
            Array.from({ length: 4 }, () => "Invalid checkpoint page layout"),
          );
        }),
      ),
    ),
  10000,
);
