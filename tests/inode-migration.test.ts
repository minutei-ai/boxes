import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Redacted, Schema } from "effect";
import { FetchHttpClient } from "effect/http";
import { initSync, Kernel, migrate_filesystem } from "../dist/kernel/cirro_kernel";
import { ExecutionCheckpoint, Head, StoredRun, MigrationReceipt } from "../src/contracts";
import { make } from "../src/sdk";
import { runtime } from "../tooling/worker-test";

initSync({
  module: new WebAssembly.Module(
    await Bun.file(new URL("../dist/kernel/cirro_kernel_bg.wasm", import.meta.url)).arrayBuffer(),
  ),
});

test(
  "filesystem cutover migrates retained checkpoint metadata, resumes a partial conversion and preserves stale CAS authority",
  () =>
    Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const directory = yield* Effect.acquireRelease(
            Effect.promise(() => mkdtemp(join(tmpdir(), "boxes-inode-migration-"))),
            (path) => Effect.promise(() => rm(path, { recursive: true, force: true })),
          );
          const worker = yield* Effect.acquireRelease(
            Effect.sync(() => runtime(directory)),
            (worker) => Effect.promise(() => worker.dispose()),
          );
          const url = (yield* Effect.promise(() => worker.ready)).toString();
          const bucket = yield* Effect.promise(() => worker.objects);
          const token = "cirro-local-test-credential";
          const admin = yield* make({ url, token: Redacted.make(token) });
          const program = Buffer.from(
            yield* Effect.promise(() => Bun.file("dist/wasi-slices-finite.wasm").arrayBuffer()),
          ).toString("base64");
          const legacy = JSON.stringify({
            version: 3,
            generation: 0,
            nextInode: 3,
            packages: [],
            links: {},
            nodes: {
              "/": { kind: "directory", mode: 493 },
              "/tmp": { kind: "directory", mode: 511 },
            },
            metadata: {
              "/": { inode: 1, uid: 0, gid: 0, atimeNs: 1, mtimeNs: 2, ctimeNs: 3 },
              "/tmp": { inode: 2, uid: 0, gid: 0, atimeNs: 4, mtimeNs: 5, ctimeNs: 6 },
            },
          });
          const migrate = Effect.fn("test.inodeMigration.run")(function* () {
            const response = yield* Effect.promise(() =>
              fetch(new URL("/v1/migrations/filesystem-v4", url), {
                method: "POST",
                headers: { authorization: `Bearer ${token}` },
              }),
            );
            return { status: response.status, body: yield* Effect.promise(() => response.text()) };
          });
          for (const id of ["unchanged", "stale", "partial"]) {
            yield* admin.create({
              id,
              policy: {
                networkHosts: [],
                interruptBudget: 1000,
                memoryBytes: 8388608,
                maxOutputBytes: 1048576,
              },
            });
            const grant = yield* admin.mintCapability(id, {
              permissions: ["read", "execute"],
              expiresInSeconds: 600,
            });
            const client = yield* make({ url, token: Redacted.make(grant.token) });
            yield* client.action(id, {
              op: "process.spawn",
              execution: { op: "process.run", id: "queued", language: "wasm", source: program },
            });
            const key = `sandboxes/${id}/head.json`;
            const root = yield* Effect.promise(() => bucket.get(key));
            if (root === null) return yield* Effect.die("Missing sandbox head");
            const head = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Head))(
              yield* Effect.promise(() => root.text()),
            );
            const oldHead = { ...head, manifest: legacy };
            const prior = yield* Effect.promise(() =>
              bucket.put(key, Schema.encodeSync(Schema.fromJsonString(Head))(oldHead)),
            );
            if (prior === null) return yield* Effect.die("Missing prior head receipt");
            const checkpoint = {
              version: 1 as const,
              heap: "0".repeat(64),
              manifest: legacy,
              checkpointManifest: legacy,
              head: oldHead,
              etag: prior.etag,
              dirty: false,
              monotonic: "0",
              savedAt: 0,
              fuelUsed: 0,
            };
            const body = yield* Schema.encodeEffect(Schema.fromJsonString(ExecutionCheckpoint))(
              checkpoint,
            );
            const hash = Buffer.from(
              yield* Effect.promise(() => crypto.subtle.digest("SHA-256", Buffer.from(body))),
            ).toString("hex");
            const checkpointKey = `sandboxes/${id}/execution-checkpoints/${hash}.json`;
            yield* Effect.promise(() => bucket.put(checkpointKey, body));
            const processKey = `processes/${id}/queued.json`;
            const process = yield* Effect.promise(() => bucket.get(processKey));
            if (process === null) return yield* Effect.die("Missing queued process");
            const record = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(StoredRun))(
              yield* Effect.promise(() => process.text()),
            );
            yield* Effect.promise(() =>
              bucket.put(
                processKey,
                Schema.encodeSync(Schema.fromJsonString(StoredRun))({
                  ...record,
                  checkpoint: hash,
                  checkpointCount: 1,
                }),
                { customMetadata: process.customMetadata },
              ),
            );
            if (id === "stale") {
              yield* Effect.promise(() =>
                bucket.put(
                  key,
                  Schema.encodeSync(Schema.fromJsonString(Head))({
                    ...oldHead,
                    policy: { ...oldHead.policy, interruptBudget: 1001 },
                  }),
                ),
              );
            }
            if (id === "partial") {
              yield* Effect.promise(() => bucket.put(checkpointKey, "corrupt"));
              expect((yield* migrate()).status).toBe(500);
              const converted = yield* Effect.promise(() => bucket.get(key));
              if (converted === null) return yield* Effect.die("Missing converted head");
              const persisted = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Head))(
                yield* Effect.promise(() => converted.text()),
              );
              const kernel = new Kernel(persisted.manifest);
              kernel.free();
              expect(converted.customMetadata?.filesystemMigrationPriorEtag).toBe(prior.etag);
              yield* Effect.promise(() => bucket.put(checkpointKey, body));
            }
            const migrated = yield* migrate();
            expect(migrated.status).toBe(200);
            yield* Schema.decodeUnknownEffect(Schema.fromJsonString(MigrationReceipt))(
              migrated.body,
            );
            const convertedRoot = yield* Effect.promise(() => bucket.get(key));
            const convertedProcess = yield* Effect.promise(() => bucket.get(processKey));
            if (convertedRoot === null || convertedProcess === null)
              return yield* Effect.die("Missing migration result");
            const updated = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(StoredRun))(
              yield* Effect.promise(() => convertedProcess.text()),
            );
            expect(updated.checkpoint).not.toBe(hash);
            if (updated.checkpoint === null)
              return yield* Effect.die("Missing migrated checkpoint");
            const saved = yield* Effect.promise(() =>
              bucket.get(`sandboxes/${id}/execution-checkpoints/${updated.checkpoint}.json`),
            );
            if (saved === null) return yield* Effect.die("Missing checkpoint object");
            const restored = yield* Schema.decodeUnknownEffect(
              Schema.fromJsonString(ExecutionCheckpoint),
            )(yield* Effect.promise(() => saved.text()));
            expect(restored.manifest).toBe(migrate_filesystem(legacy));
            expect(restored.head.manifest).toBe(restored.manifest);
            expect(restored.checkpointManifest).toBe(restored.manifest);
            expect(restored.heap).toBe(checkpoint.heap);
            expect(updated.authority).toEqual(record.authority);
            expect(updated.sourceHash).toBe(record.sourceHash);
            if (id === "stale") {
              expect(restored.etag).toBe(prior.etag);
              const rejected = yield* Effect.promise(() =>
                bucket.put(key, "must-not-publish", { onlyIf: { etagMatches: restored.etag } }),
              );
              expect(rejected).toBeNull();
            } else expect(restored.etag).toBe(convertedRoot.etag);
            const repeat = yield* migrate();
            expect(repeat.status).toBe(200);
            expect((yield* Effect.promise(() => bucket.get(processKey)))?.version).toBe(
              convertedProcess.version,
            );
          }
        }),
      ).pipe(Effect.provide(FetchHttpClient.layer)),
    ),
  15000,
);
