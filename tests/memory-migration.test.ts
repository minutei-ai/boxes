import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Clock, Effect, Redacted, Schema, Struct } from "effect";
import { FetchHttpClient } from "effect/http";
import {
  ContextHeap,
  ErrorResponse,
  MemoryMigrationInput,
  MemoryMigrationReceipt,
  StoredContext,
  checkpointMemoryCodec,
} from "../src/contracts";
import { make } from "../src/sdk";
import { runtime } from "../tooling/worker-test";
import { writeLegacyMemory } from "./fixtures/legacy-memory";

const PriorContext = StoredContext.mapFields((fields) => ({
  ...fields,
  heap: Schema.NullOr(ContextHeap.mapFields((heap) => Struct.omit(heap, ["codec"]))),
}));

test(
  "memory cutover validates legacy R2 pages and retains native JavaScript and Python closures across Worker replacement",
  () =>
    Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const directory = yield* Effect.acquireRelease(
            Effect.promise(() => mkdtemp(join(tmpdir(), "boxes-memory-migration-"))),
            (path) => Effect.promise(() => rm(path, { recursive: true, force: true })),
          );
          const saved = yield* Effect.scoped(
            Effect.gen(function* () {
              const worker = yield* Effect.acquireRelease(
                Effect.sync(() => runtime(directory, { controlled: false })),
                (worker) => Effect.promise(() => worker.dispose()),
              );
              const url = (yield* Effect.promise(() => worker.ready)).toString();
              const admin = yield* make({
                url,
                token: Redacted.make("cirro-local-test-credential"),
              });
              const id = "memory-cutover";
              yield* admin.create({
                id,
                policy: {
                  networkHosts: [],
                  interruptBudget: 100_000,
                  memoryBytes: 33_554_432,
                  maxOutputBytes: 1048576,
                },
              });
              const grant = yield* admin.mintCapability(id, {
                permissions: ["read", "write", "execute", "manage"],
                expiresInSeconds: 600,
              });
              const client = yield* make({ url, token: Redacted.make(grant.token) });
              const objects = yield* Effect.promise(() => worker.objects);
              for (const language of ["javascript", "python"] as const) {
                yield* client.action(id, { op: "contexts.create", id: language, language });
                if (language === "javascript")
                  yield* client.action(id, {
                    op: "javascript.execute",
                    id: "seed-js",
                    contextId: language,
                    source: "let value=40;globalThis.next=()=>++value;next();",
                  });
                else
                  yield* client.action(id, {
                    op: "python.execute",
                    id: "seed-py",
                    contextId: language,
                    source:
                      "value=40\ndef next_value():\n global value\n value+=1\n return value\nnext_value()",
                  });
                const key = `sandboxes/${id}/contexts/${language}.json`;
                const object = yield* Effect.promise(() => objects.get(key));
                if (object === null) return yield* Effect.die("Missing native context");
                const record = yield* Schema.decodeUnknownEffect(
                  Schema.fromJsonString(StoredContext),
                )(yield* Effect.promise(() => object.text()));
                if (record.heap === null) return yield* Effect.die("Missing native context heap");
                const heap = record.heap;
                yield* writeLegacyMemory(objects, id, heap);
                yield* Effect.promise(() =>
                  objects.put(
                    key,
                    Schema.encodeSync(Schema.fromJsonString(PriorContext))({
                      ...record,
                      heap: Struct.omit(heap, ["codec"]),
                    }),
                    { onlyIf: { etagMatches: object.etag }, customMetadata: object.customMetadata },
                  ),
                );
              }
              const packs = yield* Effect.promise(() =>
                objects.list({ prefix: `sandboxes/${id}/checkpoint-packs/`, limit: 1000 }),
              );
              expect(packs.truncated).toBe(false);
              yield* Effect.promise(() => objects.delete(packs.objects.map((entry) => entry.key)));
              return { id, token: grant.token };
            }),
          );
          const worker = yield* Effect.acquireRelease(
            Effect.sync(() => runtime(directory, { controlled: false })),
            (worker) => Effect.promise(() => worker.dispose()),
          );
          const url = (yield* Effect.promise(() => worker.ready)).toString();
          const objects = yield* Effect.promise(() => worker.objects);
          const client = yield* make({ url, token: Redacted.make(saved.token) });
          const pending = yield* client
            .action(saved.id, {
              op: "javascript.evaluate",
              id: "pending",
              contextId: "javascript",
              expression: "next()",
            })
            .pipe(Effect.result);
          expect(pending._tag).toBe("Failure");
          if (pending._tag !== "Failure" || pending.failure._tag !== "BoxesError")
            return yield* Effect.die("Legacy heap was admitted before migration");
          expect(pending.failure.status).toBe(503);
          expect(
            yield* Effect.promise(() => objects.get(`processes/${saved.id}/pending.json`)),
          ).toBeNull();
          const denied = yield* Effect.promise(() =>
            fetch(new URL("/v1/migrations/memory-packs-v1", url), {
              method: "POST",
              keepalive: false,
              headers: { authorization: `Bearer ${saved.token}` },
              body: "{}",
            }),
          );
          expect(denied.status).toBe(401);
          yield* Effect.promise(() => denied.text());
          const migrate = Effect.fn("memoryMigrationTest.page")(function* (
            cursor: typeof MemoryMigrationReceipt.Type.cursor,
          ) {
            const response = yield* Effect.promise(() =>
              fetch(new URL("/v1/migrations/memory-packs-v1", url), {
                method: "POST",
                keepalive: false,
                headers: { authorization: "Bearer cirro-local-test-credential" },
                body: Schema.encodeSync(Schema.fromJsonString(MemoryMigrationInput))({ cursor }),
              }),
            );
            return { status: response.status, body: yield* Effect.promise(() => response.text()) };
          });
          const contextKey = `sandboxes/${saved.id}/contexts/javascript.json`;
          const idleObject = yield* Effect.promise(() => objects.get(contextKey));
          if (idleObject === null) return yield* Effect.die("Missing lease fixture context");
          const idleText = yield* Effect.promise(() => idleObject.text());
          const idle = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(PriorContext))(
            idleText,
          );
          const deadlineAt = (yield* Clock.currentTimeMillis) + 60_000;
          const held = yield* Effect.promise(() =>
            objects.put(
              contextKey,
              Schema.encodeSync(Schema.fromJsonString(PriorContext))({
                ...idle,
                state: "running",
                claimId: "held",
                executionId: "held",
                deadlineAt,
              }),
              {
                onlyIf: { etagMatches: idleObject.etag },
                customMetadata: idleObject.customMetadata,
              },
            ),
          );
          if (held === null) return yield* Effect.die("Lease fixture lost its CAS");
          const leaseCursors: (typeof MemoryMigrationReceipt.Type.cursor)[] = [null];
          const lease = { observed: false, calls: 0 };
          while (leaseCursors.length > 0 && !lease.observed) {
            const waiting = yield* migrate(leaseCursors.shift() ?? null);
            expect(waiting.status).toBe(200);
            const receipt = Schema.decodeUnknownSync(Schema.fromJsonString(MemoryMigrationReceipt))(
              waiting.body,
            );
            lease.calls += 1;
            if (receipt.retryAfterMs === 1000) lease.observed = true;
            else if (receipt.cursor !== null) leaseCursors.push(receipt.cursor);
            if (lease.calls > 100)
              return yield* Effect.die("Migration did not observe the active lease");
          }
          expect(lease.observed).toBe(true);
          expect((yield* Effect.promise(() => objects.head(contextKey)))?.etag).toBe(held.etag);
          expect(
            (yield* Effect.promise(() =>
              objects.list({ prefix: `sandboxes/${saved.id}/checkpoint-packs/` }),
            )).objects.length,
          ).toBe(0);
          const released = yield* Effect.promise(() =>
            objects.put(contextKey, idleText, {
              onlyIf: { etagMatches: held.etag },
              customMetadata: idleObject.customMetadata,
            }),
          );
          if (released === null) return yield* Effect.die("Lease fixture lost release authority");
          const legacy = yield* Effect.promise(() =>
            objects.list({ prefix: `sandboxes/${saved.id}/checkpoint-pages/`, limit: 1000 }),
          );
          expect(legacy.truncated).toBe(false);
          const first = legacy.objects[0];
          if (first === undefined) return yield* Effect.die("Missing historical heap pages");
          const page = yield* Effect.promise(() => objects.get(first.key));
          if (page === null) return yield* Effect.die("Missing historical page");
          const original = yield* Effect.promise(() => page.arrayBuffer());
          const corrupted = Uint8Array.from(new Uint8Array(original));
          corrupted[0] ^= 1;
          yield* Effect.promise(() => objects.put(first.key, corrupted));
          const cursors: (typeof MemoryMigrationReceipt.Type.cursor)[] = [null];
          const counts = { migrated: 0, calls: 0, rejected: 0, packs: 0, partial: false };
          while (cursors.length > 0) {
            const cursor = cursors.shift() ?? null;
            const reply = yield* migrate(cursor);
            counts.calls += 1;
            const packs = yield* Effect.promise(() =>
              objects.list({ prefix: `sandboxes/${saved.id}/checkpoint-packs/`, limit: 1000 }),
            );
            expect(packs.truncated).toBe(false);
            expect(packs.objects.length - counts.packs).toBeLessThanOrEqual(4);
            counts.packs = packs.objects.length;
            if (reply.status === 500 && counts.rejected === 0) {
              expect(
                Schema.decodeUnknownSync(Schema.fromJsonString(ErrorResponse))(reply.body).error,
              ).toBe("INTERNAL");
              counts.rejected += 1;
              yield* Effect.promise(() => objects.put(first.key, original));
              cursors.push(cursor);
              continue;
            }
            expect(reply.status).toBe(200);
            const receipt = yield* Schema.decodeUnknownEffect(
              Schema.fromJsonString(MemoryMigrationReceipt),
            )(reply.body);
            if (receipt.migrated === 0 && packs.objects.length > 0 && !counts.partial) {
              const object = yield* Effect.promise(() =>
                objects.get(`sandboxes/${saved.id}/contexts/python.json`),
              );
              if (object === null)
                return yield* Effect.die("Missing partially migrated Python context");
              const record = yield* Schema.decodeUnknownEffect(
                Schema.fromJsonString(PriorContext),
                { onExcessProperty: "error" },
              )(yield* Effect.promise(() => object.text()));
              if (record.heap !== null) counts.partial = true;
            }
            counts.migrated += receipt.migrated;
            if (receipt.cursor !== null) cursors.push(receipt.cursor);
            if (counts.calls > 100) return yield* Effect.die("Memory migration did not converge");
          }
          expect(counts.rejected).toBe(1);
          expect(counts.migrated).toBe(2);
          expect(counts.partial).toBe(true);
          expect(counts.calls).toBeGreaterThan(4);
          const js = yield* client.action(saved.id, {
            op: "javascript.evaluate",
            id: "after-js",
            contextId: "javascript",
            expression: "next()",
          });
          const py = yield* client.action(saved.id, {
            op: "python.evaluate",
            id: "after-py",
            contextId: "python",
            expression: "next_value()",
          });
          expect(js.output?.result).toBe(42);
          expect(py.output?.result).toBe(42);
          for (const id of ["javascript", "python"]) {
            const object = yield* Effect.promise(() =>
              objects.get(`sandboxes/${saved.id}/contexts/${id}.json`),
            );
            if (object === null) return yield* Effect.die("Missing migrated context");
            const record = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(StoredContext))(
              yield* Effect.promise(() => object.text()),
            );
            expect(record.generation).toBe(0);
            expect(record.heap?.codec).toBe(checkpointMemoryCodec);
          }
          const replay = yield* migrate(null);
          expect(replay.status).toBe(200);
          expect(
            Schema.decodeUnknownSync(Schema.fromJsonString(MemoryMigrationReceipt))(replay.body)
              .migrated,
          ).toBe(0);
          expect(
            (yield* Effect.promise(() =>
              objects.list({ prefix: `sandboxes/${saved.id}/checkpoint-pages/`, limit: 1000 }),
            )).objects.length,
          ).toBe(legacy.objects.length);
        }),
      ).pipe(
        Effect.provide(FetchHttpClient.layer),
        Effect.provideService(FetchHttpClient.RequestInit, { keepalive: false }),
      ),
    ),
  30000,
);
