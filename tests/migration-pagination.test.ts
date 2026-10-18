import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Redacted, Schema } from "effect";
import { FetchHttpClient } from "effect/http";
import {
  FilesystemMigrationInput,
  FilesystemMigrationReceipt,
  Head,
  StoredRun,
} from "../src/contracts";
import { make } from "../src/sdk";
import { runtime } from "../tooling/worker-test";

test(
  "filesystem migration pages survive Worker replacement and repeated cursors without rewriting converted roots",
  () =>
    Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const directory = yield* Effect.acquireRelease(
            Effect.promise(() => mkdtemp(join(tmpdir(), "boxes-migration-pages-"))),
            (path) => Effect.promise(() => rm(path, { recursive: true, force: true })),
          );
          const first = yield* Effect.acquireRelease(
            Effect.sync(() => runtime(directory)),
            (worker) => Effect.promise(() => worker.dispose()),
          );
          const url = (yield* Effect.promise(() => first.ready)).toString();
          const token = "cirro-local-test-credential";
          const admin = yield* make({ url, token: Redacted.make(token) });
          yield* admin.create({
            id: "seed",
            policy: {
              networkHosts: [],
              interruptBudget: 1000,
              memoryBytes: 8388608,
              maxOutputBytes: 1048576,
            },
          });
          const grant = yield* admin.mintCapability("seed", {
            permissions: ["read", "execute"],
            expiresInSeconds: 600,
          });
          const client = yield* make({ url, token: Redacted.make(grant.token) });
          yield* client.action("seed", {
            op: "process.spawn",
            execution: { op: "process.run", id: "seed", language: "javascript", source: "42" },
          });
          const bucket = yield* Effect.promise(() => first.objects);
          const root = yield* Effect.promise(() => bucket.get("sandboxes/seed/head.json"));
          const process = yield* Effect.promise(() => bucket.get("processes/seed/seed.json"));
          if (root === null || process === null)
            return yield* Effect.die("Missing native seed records");
          const head = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Head))(
            yield* Effect.promise(() => root.text()),
          );
          const record = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(StoredRun))(
            yield* Effect.promise(() => process.text()),
          );
          const legacy = JSON.stringify({
            version: 1,
            generation: 17,
            nodes: { "/": { kind: "directory", mode: 493 } },
          });
          for (const index of Array.from({ length: 26 }, (_, index) => index)) {
            const id = `legacy-${index.toString().padStart(2, "0")}`;
            yield* Effect.promise(() =>
              bucket.put(
                `sandboxes/${id}/head.json`,
                Schema.encodeSync(Schema.fromJsonString(Head))({ ...head, manifest: legacy }),
              ),
            );
            yield* Effect.promise(() =>
              bucket.put(
                `processes/seed/${id}.json`,
                Schema.encodeSync(Schema.fromJsonString(StoredRun))({ ...record, id }),
                { customMetadata: process.customMetadata },
              ),
            );
          }
          yield* Effect.promise(() => bucket.put("sandboxes/orphan/blobs/unreferenced", "orphan"));
          const page = Effect.fn("test.filesystemMigration.page")(function* (
            origin: string,
            cursor: typeof FilesystemMigrationReceipt.Type.cursor,
          ) {
            const response = yield* Effect.promise(() =>
              fetch(new URL("/v1/migrations/filesystem-v6", origin), {
                method: "POST",
                keepalive: false,
                headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
                body: Schema.encodeSync(Schema.fromJsonString(FilesystemMigrationInput))({
                  cursor,
                }),
              }),
            );
            expect(response.status).toBe(200);
            return yield* Schema.decodeUnknownEffect(
              Schema.fromJsonString(FilesystemMigrationReceipt),
            )(yield* Effect.promise(() => response.text()));
          });
          const initial = yield* page(url, null);
          expect(initial.migrated).toBe(25);
          expect(initial.cursor?.phase).toBe("heads");
          const converted = yield* Effect.promise(() =>
            bucket.get("sandboxes/legacy-00/head.json"),
          );
          const pending = yield* Effect.promise(() => bucket.get("sandboxes/legacy-25/head.json"));
          if (converted === null || pending === null)
            return yield* Effect.die("Missing bounded page roots");
          expect(
            JSON.parse(
              Schema.decodeUnknownSync(Schema.fromJsonString(Head))(
                yield* Effect.promise(() => pending.text()),
              ).manifest,
            ).version,
          ).toBe(1);
          yield* Effect.promise(() => first.dispose());
          const replacement = yield* Effect.acquireRelease(
            Effect.sync(() => runtime(directory)),
            (worker) => Effect.promise(() => worker.dispose()),
          );
          const origin = (yield* Effect.promise(() => replacement.ready)).toString();
          const repeated = yield* page(origin, null);
          expect(repeated.migrated).toBe(0);
          expect(repeated.cursor).toEqual(initial.cursor);
          const nextBucket = yield* Effect.promise(() => replacement.objects);
          expect(
            (yield* Effect.promise(() => nextBucket.get("sandboxes/legacy-00/head.json")))?.version,
          ).toBe(converted.version);
          const cursors = [initial.cursor];
          const totals = { migrated: initial.migrated, pages: 1, checkpointPages: 0 };
          while (cursors.length > 0) {
            const cursor = cursors.shift();
            if (cursor === undefined) return yield* Effect.die("Missing continuation");
            const receipt = yield* page(origin, cursor);
            totals.migrated += receipt.migrated;
            totals.pages += 1;
            if (cursor?.phase === "checkpoints") totals.checkpointPages += 1;
            if (receipt.cursor !== null) cursors.push(receipt.cursor);
          }
          expect(totals).toEqual({ migrated: 26, pages: 4, checkpointPages: 2 });
          for (const index of Array.from({ length: 26 }, (_, index) => index)) {
            const key = `sandboxes/legacy-${index.toString().padStart(2, "0")}/head.json`;
            const object = yield* Effect.promise(() => nextBucket.get(key));
            if (object === null) return yield* Effect.die("Missing converted root");
            const stored = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Head))(
              yield* Effect.promise(() => object.text()),
            );
            expect(JSON.parse(stored.manifest)).toMatchObject({
              version: 6,
              generation: 17,
              retainers: {},
            });
          }
          const denied = yield* Effect.promise(() =>
            fetch(new URL("/v1/migrations/filesystem-v6", origin), {
              method: "POST",
              keepalive: false,
              headers: { authorization: `Bearer ${grant.token}` },
              body: "{}",
            }),
          );
          expect(denied.status).toBe(401);
          const invalid = yield* Effect.promise(() =>
            fetch(new URL("/v1/migrations/filesystem-v6", origin), {
              method: "POST",
              keepalive: false,
              headers: { authorization: `Bearer ${token}` },
              body: JSON.stringify({ cursor: { phase: "ignored", continuation: null } }),
            }),
          );
          expect(invalid.status).toBe(400);
        }),
      ).pipe(Effect.provide(FetchHttpClient.layer)),
    ),
  15000,
);
