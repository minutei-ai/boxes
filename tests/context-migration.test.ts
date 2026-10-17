import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Clock, Effect, Redacted, Schema, Struct } from "effect";
import { FetchHttpClient } from "effect/http";
import { ContextMigrationInput, ContextMigrationReceipt, StoredContext } from "../src/contracts";
import { PreviousContext } from "../src/context-migration";
import { make } from "../src/sdk";
import { runtime } from "../tooling/worker-test";

const PreviousSummary = PreviousContext.mapFields((fields) =>
  Struct.omit(fields, ["heap", "claimId"]),
);

test(
  "context language cutover preserves heaps and tombstones across both pagination boundaries and fences old writes",
  () =>
    Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const directory = yield* Effect.acquireRelease(
            Effect.promise(() => mkdtemp(join(tmpdir(), "boxes-context-migration-"))),
            (path) => Effect.promise(() => rm(path, { recursive: true, force: true })),
          );
          const worker = yield* Effect.acquireRelease(
            Effect.sync(() => runtime(directory, { controlled: false })),
            (worker) => Effect.promise(() => worker.dispose()),
          );
          const url = (yield* Effect.promise(() => worker.ready)).toString();
          const adminToken = "cirro-local-test-credential";
          const admin = yield* make({ url, token: Redacted.make(adminToken) });
          yield* Effect.forEach(
            Array.from({ length: 26 }, (_, index) => `migr-${String(index).padStart(2, "0")}`),
            (id) =>
              admin.create({
                id,
                policy: {
                  networkHosts: [],
                  interruptBudget: 1000,
                  memoryBytes: 8388608,
                  maxOutputBytes: 1048576,
                },
              }),
            { concurrency: 4 },
          );
          const grant = yield* admin.mintCapability("migr-00", {
            permissions: ["read", "execute", "manage"],
            expiresInSeconds: 600,
          });
          const client = yield* make({ url, token: Redacted.make(grant.token) });
          for (const id of [
            "heap",
            "deleted",
            "busy",
            ...Array.from({ length: 8 }, (_, index) => `state-${index}`),
          ])
            yield* client.action("migr-00", { op: "contexts.create", id });
          yield* client.action("migr-00", {
            op: "javascript.execute",
            id: "seed",
            contextId: "heap",
            source: "let n=40;globalThis.next=()=>++n;",
          });
          yield* client.action("migr-00", { op: "contexts.delete", id: "deleted" });
          const objects = yield* Effect.promise(() => worker.objects);
          const inventory = yield* Effect.promise(() =>
            objects.list({ prefix: "sandboxes/migr-00/contexts/" }),
          );
          const now = yield* Clock.currentTimeMillis;
          const old = yield* Effect.forEach(
            inventory.objects,
            (entry) =>
              Effect.gen(function* () {
                const object = yield* Effect.promise(() => objects.get(entry.key));
                if (object === null) return yield* Effect.die("Missing migration fixture");
                const record = yield* Schema.decodeUnknownEffect(
                  Schema.fromJsonString(StoredContext),
                )(yield* Effect.promise(() => object.text()));
                const previous = yield* Effect.sync(() => {
                  const value = Struct.omit(record, ["language"]);
                  if (record.id === "busy")
                    return {
                      ...value,
                      state: "running" as const,
                      claimId: "old-claim",
                      executionId: "old-run",
                      deadlineAt: now - 1,
                    };
                  return value;
                });
                const body = Schema.encodeSync(Schema.fromJsonString(PreviousContext))(previous);
                const saved = yield* Effect.promise(() =>
                  objects.put(entry.key, body, {
                    customMetadata: {
                      summary: Schema.encodeSync(Schema.fromJsonString(PreviousSummary))(
                        Struct.omit(previous, ["heap", "claimId"]),
                      ),
                    },
                  }),
                );
                return { key: entry.key, body, etag: saved.etag };
              }),
            { concurrency: 4 },
          );
          const legacyRead = yield* client
            .action("migr-00", { op: "contexts.get", id: "heap" })
            .pipe(Effect.result);
          if (legacyRead._tag !== "Failure" || legacyRead.failure._tag !== "BoxesError")
            return yield* Effect.die("Runtime admitted a legacy context");
          expect(legacyRead.failure.status).toBe(503);
          const denied = yield* Effect.promise(() =>
            fetch(new URL("/v1/migrations/context-language-v1", url), {
              method: "POST",
              headers: { authorization: `Bearer ${grant.token}` },
              body: "{}",
            }),
          );
          expect(denied.status).toBe(401);
          const migrate = Effect.fn("contextMigrationTest.run")(function* () {
            const cursors: (typeof ContextMigrationReceipt.Type.cursor)[] = [null];
            const result = { migrated: 0, pages: 0 };
            while (cursors.length > 0) {
              const cursor = cursors.shift();
              const response = yield* Effect.promise(() =>
                fetch(new URL("/v1/migrations/context-language-v1", url), {
                  method: "POST",
                  headers: { authorization: `Bearer ${adminToken}` },
                  body: Schema.encodeSync(Schema.fromJsonString(ContextMigrationInput))({ cursor }),
                }),
              );
              if (response.status !== 200)
                return yield* Effect.die({
                  status: response.status,
                  body: yield* Effect.promise(() => response.text()),
                });
              const receipt = yield* Schema.decodeUnknownEffect(
                Schema.fromJsonString(ContextMigrationReceipt),
              )(yield* Effect.promise(() => response.text()));
              result.migrated += receipt.migrated;
              result.pages += 1;
              if (receipt.cursor !== null) cursors.push(receipt.cursor);
            }
            return result;
          });
          const control = yield* Effect.promise(() => worker.control);
          const firstPage = yield* Effect.promise(() => control.contextMigration({}));
          expect([firstPage.migrated, firstPage.reads]).toEqual([8, 8]);
          const converted = yield* migrate();
          expect(firstPage.migrated + converted.migrated).toBe(11);
          expect(converted.pages).toBeGreaterThanOrEqual(3);
          expect((yield* migrate()).migrated).toBe(0);
          expect((yield* Effect.promise(() => control.contextMigration({}))).reads).toBe(0);
          expect(
            (yield* client.action("migr-00", { op: "contexts.get", id: "heap" })).language,
          ).toBe("javascript");
          expect(
            (yield* client.action("migr-00", {
              op: "javascript.evaluate",
              id: "resumed",
              contextId: "heap",
              expression: "globalThis.next()",
            })).output?.result,
          ).toBe(41);
          const busy = old.find((entry) => entry.key.endsWith("/busy.json"));
          if (busy === undefined) return yield* Effect.die("Missing old claim");
          const stale = yield* Effect.promise(() =>
            objects.put(busy.key, busy.body, { onlyIf: { etagMatches: busy.etag } }),
          );
          expect(stale).toBeNull();
          const active = yield* client.action("migr-00", { op: "contexts.get", id: "busy" });
          expect([active.language, active.state, active.executionId, active.deadlineAt]).toEqual([
            "javascript",
            "running",
            "old-run",
            now - 1,
          ]);
          yield* client.action("migr-00", { op: "contexts.reset", id: "busy" });
          expect(
            (yield* client.action("migr-00", {
              op: "contexts.create",
              id: "deleted",
              language: "python",
            })).generation,
          ).toBe(2);
        }),
      ).pipe(Effect.provide(FetchHttpClient.layer)),
    ),
  60_000,
);
