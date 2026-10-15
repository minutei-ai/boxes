import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Schema } from "effect";
import { Head, Id } from "../src/contracts";
import { PersistentDriverProof } from "./fixtures/sdk-binding-worker";
import { runtime } from "../tooling/worker-test";

test(
  "persistent Code Mode retains files across closed contexts and replacement Workers without management authority",
  () =>
    Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const directory = yield* Effect.acquireRelease(
            Effect.promise(() => mkdtemp(join(tmpdir(), "boxes-persistent-driver-"))),
            (path) => Effect.promise(() => rm(path, { recursive: true, force: true })),
          );
          for (const phase of ["create", "read"]) {
            yield* Effect.scoped(
              Effect.gen(function* () {
                const worker = yield* Effect.acquireRelease(
                  Effect.sync(() => runtime(directory, { binding: true })),
                  (worker) => Effect.promise(() => worker.dispose()),
                );
                const url = yield* Effect.promise(() => worker.binding());
                url.searchParams.set("persistent", phase);
                const response = yield* Effect.promise(() =>
                  fetch(url, {
                    method: "POST",
                    body: Schema.encodeSync(Schema.fromJsonString(Id))("persistent-driver"),
                  }),
                );
                expect(response.status).toBe(200);
                const proof = yield* Schema.decodeUnknownEffect(PersistentDriverProof)(
                  yield* Effect.promise(() => response.json()),
                );
                expect(Buffer.from(proof.file.content, proof.file.encoding).toString()).toBe(
                  "confirmed",
                );
                expect(proof.cancelled).toBe(true);
                expect(proof.lateWrites).toEqual([]);
                expect(proof.lowMemoryRejected).toBe(true);
                expect(proof.sandboxLimitEnforced).toBe(true);
                expect(proof.allocation).toBe(20000000);
                expect(proof.writeDenied).toBe(true);
                expect(proof.sandboxMemoryBytes).toBe(33554432);
                expect(proof.callbacks).toEqual([`${phase}:small`, `${phase}:large`]);
                expect(proof.foreignStatus).toBe("queued");
                const objects = yield* Effect.promise(() => worker.objects);
                const stored = yield* Effect.promise(() =>
                  objects.get("sandboxes/persistent-driver/head.json"),
                );
                if (stored === null) return yield* Effect.die("Sandbox head missing");
                const head = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Head))(
                  yield* Effect.promise(() => stored.text()),
                );
                expect(head.deleted).toBe(phase === "read");
              }),
            );
          }
        }),
      ),
    ),
  15000,
);
