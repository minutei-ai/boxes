import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Schema } from "effect";
import { ErrorResponse } from "../src/contracts";
import { runtime } from "../tooling/worker-test";
import {
  ContextCheckpointRequest,
  ContextCheckpointProof,
  ContextMemory,
} from "./fixtures/context-checkpoint-contract";

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
          const blob = yield* Effect.promise(() =>
            objects.get(`context-heap/${metadata.digest}.bin`),
          );
          if (blob === null) return yield* Effect.die("Missing native R2 context image");
          const original = yield* Effect.promise(() => blob.arrayBuffer());
          const corrupt = new Uint8Array(original.slice(0));
          corrupt[corrupt.byteLength - 1] ^= 1;
          yield* Effect.promise(() => objects.put(`context-heap/${metadata.digest}.bin`, corrupt));
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
          yield* Effect.promise(() => objects.put(`context-heap/${metadata.digest}.bin`, original));
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
