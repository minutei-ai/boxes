import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Redacted, Schema, Struct } from "effect";
import { FetchHttpClient } from "effect/http";
import {
  EnvironmentMigrationInput,
  EnvironmentMigrationReceipt,
  Head,
  StoredRun,
  StoredRunMetadata,
  Program,
  ExecutionCheckpoint,
  ProcessDelivery,
} from "../src/contracts";
import { make } from "../src/sdk";
import { runtime } from "../tooling/worker-test";

test(
  "configuration cutover converts legacy inputs in bounded replayable pages without admitting old jobs",
  () =>
    Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const directory = yield* Effect.acquireRelease(
            Effect.promise(() => mkdtemp(join(tmpdir(), "boxes-config-migration-"))),
            (path) => Effect.promise(() => rm(path, { recursive: true, force: true })),
          );
          const first = yield* Effect.acquireRelease(
            Effect.sync(() => runtime(directory)),
            (worker) => Effect.promise(() => worker.dispose()),
          );
          const url = (yield* Effect.promise(() => first.ready)).toString();
          const token = "cirro-local-test-credential";
          const admin = yield* make({ url, token: Redacted.make(token) });
          const id = "legacy";
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
            permissions: ["read", "execute", "manage"],
            expiresInSeconds: 600,
          });
          const client = yield* make({ url, token: Redacted.make(grant.token) });
          yield* client.action(id, {
            op: "process.spawn",
            execution: {
              op: "javascript.evaluate",
              id: "queued",
              expression: "Object.keys(process.env).length",
            },
          });
          const bucket = yield* Effect.promise(() => first.objects);
          const root = yield* Effect.promise(() => bucket.get(`sandboxes/${id}/head.json`));
          const process = yield* Effect.promise(() => bucket.get(`processes/${id}/queued.json`));
          if (root === null || process === null)
            return yield* Effect.die("Missing native migration seed");
          const head = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Head))(
            yield* Effect.promise(() => root.text()),
          );
          const record = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(StoredRun))(
            yield* Effect.promise(() => process.text()),
          );
          const metadata = yield* Schema.decodeUnknownEffect(StoredRunMetadata)(
            process.customMetadata,
          );
          const source = yield* Effect.promise(() =>
            bucket.get(`sandboxes/${id}/code/${record.sourceHash}`),
          );
          if (source === null) return yield* Effect.die("Missing source seed");
          const program = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Program))(
            yield* Effect.promise(() => source.text()),
          );
          const legacySource = Buffer.from(JSON.stringify(Struct.omit(program, ["env"])));
          const legacyHash = Buffer.from(
            yield* Effect.promise(() => crypto.subtle.digest("SHA-256", legacySource)),
          ).toString("hex");
          yield* Effect.promise(() =>
            bucket.put(`sandboxes/${id}/code/${legacyHash}`, legacySource, {
              customMetadata: { format: "program-json" },
            }),
          );
          yield* Effect.promise(() =>
            bucket.put(
              `processes/${id}/queued.json`,
              Schema.encodeSync(Schema.fromJsonString(StoredRun))({
                ...record,
                sourceHash: legacyHash,
              }),
              {
                customMetadata: Schema.encodeSync(StoredRunMetadata)({
                  ...metadata,
                  summary: { ...metadata.summary, sourceHash: legacyHash },
                }),
              },
            ),
          );
          const previousHead = { ...Struct.omit(head, ["environment"]), version: 2 };
          const prior = yield* Effect.promise(() =>
            bucket.put(`sandboxes/${id}/head.json`, JSON.stringify(previousHead)),
          );
          if (prior === null) return yield* Effect.die("Missing prior head receipt");
          for (const index of Array.from({ length: 26 }, (_, index) => index))
            yield* Effect.promise(() =>
              bucket.put(
                `sandboxes/copy-${index.toString().padStart(2, "0")}/head.json`,
                JSON.stringify(previousHead),
              ),
            );
          const deliver = Effect.fn("test.configuration.deliver")(function* (
            worker: ReturnType<typeof runtime>,
            processId: string,
          ) {
            const objects = yield* Effect.promise(() => worker.objects);
            const key = `processes/${id}/${processId}.json`;
            const current = yield* Effect.promise(() => objects.head(key));
            if (current === null) return yield* Effect.die("Missing migration delivery");
            const control = yield* Effect.promise(() => worker.control);
            yield* Effect.promise(() =>
              control.deliver("executions", [
                {
                  id: "migration",
                  timestamp: new Date(),
                  attempts: 1,
                  body: Schema.encodeSync(ProcessDelivery)({ key, eTag: current.etag }),
                },
              ]),
            );
          });
          yield* deliver(first, "queued");
          expect(
            (yield* Effect.promise(() => bucket.get(`processes/${id}/queued.json`)))?.etag,
          ).not.toBeNull();
          const pending = yield* Effect.promise(() => bucket.get(`processes/${id}/queued.json`));
          if (pending === null) return yield* Effect.die("Missing pending legacy receipt");
          expect(
            Schema.decodeUnknownSync(Schema.fromJsonString(StoredRun))(
              yield* Effect.promise(() => pending.text()),
            ).status,
          ).toBe("queued");
          const page = Effect.fn("test.configuration.page")(function* (
            origin: string,
            cursor: typeof EnvironmentMigrationReceipt.Type.cursor,
          ) {
            const response = yield* Effect.promise(() =>
              fetch(new URL("/v1/migrations/environment-v1", origin), {
                method: "POST",
                keepalive: false,
                headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
                body: Schema.encodeSync(Schema.fromJsonString(EnvironmentMigrationInput))({
                  cursor,
                }),
              }),
            );
            expect(response.status).toBe(200);
            return yield* Schema.decodeUnknownEffect(
              Schema.fromJsonString(EnvironmentMigrationReceipt),
            )(yield* Effect.promise(() => response.text()));
          });
          const firstPage = yield* page(url, null);
          expect(firstPage.migrated).toBe(25);
          expect(firstPage.cursor?.phase).toBe("heads");
          yield* Effect.promise(() => first.dispose());
          const replacement = yield* Effect.acquireRelease(
            Effect.sync(() => runtime(directory)),
            (worker) => Effect.promise(() => worker.dispose()),
          );
          const origin = (yield* Effect.promise(() => replacement.ready)).toString();
          expect((yield* page(origin, null)).migrated).toBe(0);
          const cursors = [firstPage.cursor];
          const progress = { migrated: firstPage.migrated };
          while (cursors.length > 0) {
            const cursor = cursors.shift();
            if (cursor === undefined) return yield* Effect.die("Missing migration continuation");
            const next = yield* page(origin, cursor);
            progress.migrated += next.migrated;
            if (next.cursor !== null) cursors.push(next.cursor);
          }
          expect(progress.migrated).toBe(28);
          const nextClient = yield* make({ url: origin, token: Redacted.make(grant.token) });
          expect((yield* nextClient.action(id, { op: "config.get" })).environment).toEqual({});
          const nextBucket = yield* Effect.promise(() => replacement.objects);
          const converted = yield* Effect.promise(() =>
            nextBucket.get(`processes/${id}/queued.json`),
          );
          if (converted === null) return yield* Effect.die("Missing converted process");
          const current = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(StoredRun))(
            yield* Effect.promise(() => converted.text()),
          );
          expect(current.sourceHash).not.toBe(legacyHash);
          expect(current.authority).toEqual(record.authority);
          expect(current.status).toBe("queued");
          yield* deliver(replacement, "queued");
          expect(
            (yield* nextClient.action(id, { op: "process.get", id: "queued" })).output?.result,
          ).toBe(0);
          const repeat = yield* page(origin, { phase: "processes", continuation: null });
          expect(repeat.migrated).toBe(0);
        }),
      ).pipe(Effect.provide(FetchHttpClient.layer)),
    ),
  20000,
);

test(
  "configuration checkpoint conversion resumes partial cutover and never rebases stale authority",
  () =>
    Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const directory = yield* Effect.acquireRelease(
            Effect.promise(() => mkdtemp(join(tmpdir(), "boxes-config-checkpoint-"))),
            (path) => Effect.promise(() => rm(path, { recursive: true, force: true })),
          );
          const worker = yield* Effect.acquireRelease(
            Effect.sync(() => runtime(directory)),
            (value) => Effect.promise(() => value.dispose()),
          );
          const url = (yield* Effect.promise(() => worker.ready)).toString();
          const token = "cirro-local-test-credential";
          const admin = yield* make({ url, token: Redacted.make(token) });
          const bucket = yield* Effect.promise(() => worker.objects);
          const migrate = Effect.fn("test.configuration.checkpoints")(function* () {
            const cursors: (typeof EnvironmentMigrationReceipt.Type.cursor)[] = [null];
            while (cursors.length > 0) {
              const response = yield* Effect.promise(() =>
                fetch(new URL("/v1/migrations/environment-v1", url), {
                  method: "POST",
                  keepalive: false,
                  headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
                  body: Schema.encodeSync(Schema.fromJsonString(EnvironmentMigrationInput))({
                    cursor: cursors.shift(),
                  }),
                }),
              );
              if (response.status !== 200) return response.status;
              const page = yield* Schema.decodeUnknownEffect(
                Schema.fromJsonString(EnvironmentMigrationReceipt),
              )(yield* Effect.promise(() => response.text()));
              if (page.cursor !== null) cursors.push(page.cursor);
            }
            return 200;
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
              execution: {
                op: "process.run",
                id: "checkpoint",
                language: "wasm",
                source: "AGFzbQEAAAA=",
              },
            });
            const key = `sandboxes/${id}/head.json`;
            const root = yield* Effect.promise(() => bucket.get(key));
            if (root === null) return yield* Effect.die("Missing checkpoint root");
            const head = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Head))(
              yield* Effect.promise(() => root.text()),
            );
            const oldHead = { ...Struct.omit(head, ["environment"]), version: 2 };
            const previous = yield* Effect.promise(() => bucket.put(key, JSON.stringify(oldHead)));
            if (previous === null) return yield* Effect.die("Missing prior checkpoint root");
            const checkpoint = {
              version: 1,
              heap: "0".repeat(64),
              manifest: head.manifest,
              checkpointManifest: head.manifest,
              head: oldHead,
              etag: previous.etag,
              dirty: false,
              monotonic: "0",
              savedAt: 0,
              fuelUsed: 0,
            };
            const body = Buffer.from(JSON.stringify(checkpoint));
            const hash = Buffer.from(
              yield* Effect.promise(() => crypto.subtle.digest("SHA-256", body)),
            ).toString("hex");
            const checkpointKey = `sandboxes/${id}/execution-checkpoints/${hash}.json`;
            yield* Effect.promise(() => bucket.put(checkpointKey, body));
            const processKey = `processes/${id}/checkpoint.json`;
            const process = yield* Effect.promise(() => bucket.get(processKey));
            if (process === null) return yield* Effect.die("Missing checkpoint process");
            const record = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(StoredRun))(
              yield* Effect.promise(() => process.text()),
            );
            const receipt = yield* Effect.promise(() =>
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
            if (receipt === null) return yield* Effect.die("Missing seeded checkpoint receipt");
            const control = yield* Effect.promise(() => worker.control);
            yield* Effect.promise(() =>
              control.deliver("executions", [
                {
                  id,
                  timestamp: new Date(),
                  attempts: 1,
                  body: Schema.encodeSync(ProcessDelivery)({ key: processKey, eTag: receipt.etag }),
                },
              ]),
            );
            expect((yield* Effect.promise(() => bucket.head(processKey)))?.etag).toBe(receipt.etag);
            if (id === "stale")
              yield* Effect.promise(() =>
                bucket.put(
                  key,
                  JSON.stringify({
                    ...oldHead,
                    policy: { ...oldHead.policy, interruptBudget: 1001 },
                  }),
                ),
              );
            if (id === "partial") {
              yield* Effect.promise(() => bucket.put(checkpointKey, "corrupt"));
              expect(yield* migrate()).toBe(500);
              const converted = yield* Effect.promise(() => bucket.get(key));
              if (converted === null) return yield* Effect.die("Missing partially converted root");
              expect(converted.customMetadata?.configurationMigrationPriorEtag).toBe(previous.etag);
              expect(
                Schema.decodeUnknownSync(Schema.fromJsonString(Head))(
                  yield* Effect.promise(() => converted.text()),
                ).environment,
              ).toEqual({});
              yield* Effect.promise(() => bucket.put(checkpointKey, body));
            }
            expect(yield* migrate()).toBe(200);
            const current = yield* Effect.promise(() => bucket.get(key));
            const updated = yield* Effect.promise(() => bucket.get(processKey));
            if (current === null || updated === null)
              return yield* Effect.die("Missing converted checkpoint state");
            const stored = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(StoredRun))(
              yield* Effect.promise(() => updated.text()),
            );
            expect(stored.authority).toEqual(record.authority);
            expect(stored.sourceHash).toBe(record.sourceHash);
            expect(stored.checkpoint).not.toBe(hash);
            const saved = yield* Effect.promise(() =>
              bucket.get(`sandboxes/${id}/execution-checkpoints/${stored.checkpoint}.json`),
            );
            if (saved === null) return yield* Effect.die("Missing converted checkpoint");
            const converted = yield* Schema.decodeUnknownEffect(
              Schema.fromJsonString(ExecutionCheckpoint),
            )(yield* Effect.promise(() => saved.text()));
            expect(converted.head.version).toBe(3);
            expect(converted.head.environment).toEqual({});
            expect(converted.heap).toBe(checkpoint.heap);
            if (id === "stale") {
              expect(converted.etag).toBe(previous.etag);
              expect(
                yield* Effect.promise(() =>
                  bucket.put(key, "must-not-publish", { onlyIf: { etagMatches: converted.etag } }),
                ),
              ).toBeNull();
            } else expect(converted.etag).toBe(current.etag);
            expect(yield* migrate()).toBe(200);
            expect((yield* Effect.promise(() => bucket.head(processKey)))?.version).toBe(
              updated.version,
            );
          }
        }),
      ).pipe(Effect.provide(FetchHttpClient.layer)),
    ),
  20000,
);

test(
  "configuration cutover retains pre-module terminal sources without accepting malformed program archives",
  () =>
    Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const directory = yield* Effect.acquireRelease(
            Effect.promise(() => mkdtemp(join(tmpdir(), "boxes-historical-source-"))),
            (path) => Effect.promise(() => rm(path, { recursive: true, force: true })),
          );
          const worker = yield* Effect.acquireRelease(
            Effect.sync(() => runtime(directory)),
            (value) => Effect.promise(() => value.dispose()),
          );
          const url = (yield* Effect.promise(() => worker.ready)).toString();
          const admin = yield* make({ url, token: Redacted.make("cirro-local-test-credential") });
          const id = "historical-source";
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
            op: "javascript.evaluate",
            id: "historical",
            expression: "42",
          });
          const bucket = yield* Effect.promise(() => worker.objects);
          const key = `processes/${id}/historical.json`;
          const object = yield* Effect.promise(() => bucket.get(key));
          if (object === null) return yield* Effect.die("Missing historical seed");
          const seed = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(StoredRun))(
            yield* Effect.promise(() => object.text()),
          );
          const metadata = yield* Schema.decodeUnknownEffect(StoredRunMetadata)(
            object.customMetadata,
          );
          const source = "export default () => { while (true) {} };";
          const sourceHash = Buffer.from(
            yield* Effect.promise(() => crypto.subtle.digest("SHA-256", Buffer.from(source))),
          ).toString("hex");
          const codeKey = `sandboxes/${id}/code/${sourceHash}`;
          const historical = {
            ...seed,
            sourceHash,
            status: "failed" as const,
            output: null,
            authority: null,
            deadlineAt: null,
          };
          yield* Effect.promise(() =>
            bucket.put(key, Schema.encodeSync(Schema.fromJsonString(StoredRun))(historical), {
              customMetadata: Schema.encodeSync(StoredRunMetadata)({
                ...metadata,
                summary: { ...metadata.summary, sourceHash, status: "failed" },
              }),
            }),
          );
          yield* Effect.promise(() =>
            bucket.put(codeKey, source, { customMetadata: { format: "program-json" } }),
          );
          const migrate = Effect.fn("test.configuration.historical")(function* () {
            return yield* Effect.promise(() =>
              fetch(new URL("/v1/migrations/environment-v1", url), {
                method: "POST",
                headers: {
                  authorization: "Bearer cirro-local-test-credential",
                  "content-type": "application/json",
                },
                body: Schema.encodeSync(Schema.fromJsonString(EnvironmentMigrationInput))({
                  cursor: { phase: "processes", continuation: null },
                }),
              }),
            );
          });
          expect((yield* migrate()).status).toBe(500);
          expect((yield* Effect.promise(() => bucket.head(codeKey)))?.customMetadata?.format).toBe(
            "program-json",
          );
          for (const language of ["typescript", "python", "shell"] as const) {
            const processId = `archived-${language}`;
            yield* Effect.promise(() =>
              bucket.put(
                `processes/${id}/${processId}.json`,
                Schema.encodeSync(Schema.fromJsonString(StoredRun))({
                  ...historical,
                  id: processId,
                  language,
                }),
                {
                  customMetadata: Schema.encodeSync(StoredRunMetadata)({
                    ...metadata,
                    summary: {
                      ...metadata.summary,
                      sourceHash,
                      id: processId,
                      language,
                      status: "failed",
                    },
                  }),
                },
              ),
            );
          }
          yield* Effect.promise(() => bucket.put(codeKey, source));
          expect((yield* migrate()).status).toBe(200);
          const retained = yield* Effect.promise(() => bucket.get(codeKey));
          if (retained === null) return yield* Effect.die("Historical source was lost");
          expect(retained.customMetadata?.format).toBe("historical-source-text-v1");
          expect(yield* Effect.promise(() => retained.text())).toBe(source);
          const observed = yield* client.action(id, { op: "process.get", id: "historical" });
          expect([observed.status, observed.sourceHash, observed.output]).toEqual([
            "failed",
            sourceHash,
            null,
          ]);
          expect((yield* migrate()).status).toBe(200);
          expect((yield* Effect.promise(() => bucket.head(codeKey)))?.etag).toBe(retained.etag);
          for (const language of ["typescript", "python", "shell"] as const) {
            const processId = `archived-${language}`;
            expect((yield* client.action(id, { op: "process.get", id: processId })).status).toBe(
              "failed",
            );
            yield* Effect.promise(() => bucket.delete(`processes/${id}/${processId}.json`));
          }
          yield* Effect.promise(() => bucket.put(codeKey, source));
          yield* Effect.promise(() =>
            bucket.put(
              key,
              Schema.encodeSync(Schema.fromJsonString(StoredRun))({
                ...historical,
                status: "queued",
              }),
              {
                customMetadata: Schema.encodeSync(StoredRunMetadata)({
                  ...metadata,
                  summary: { ...metadata.summary, sourceHash, status: "queued" },
                }),
              },
            ),
          );
          expect((yield* migrate()).status).toBe(500);
          expect(
            (yield* Effect.promise(() => bucket.head(codeKey)))?.customMetadata?.format,
          ).toBeUndefined();
          const sources = {
            typescript: "export default () => 42;",
            python: "print(42)",
            shell: "echo 42",
          };
          for (const language of ["typescript", "python", "shell"] as const) {
            const text = sources[language];
            const hash = Buffer.from(
              yield* Effect.promise(() => crypto.subtle.digest("SHA-256", Buffer.from(text))),
            ).toString("hex");
            const path = `sandboxes/${id}/code/${hash}`;
            yield* Effect.promise(() => bucket.put(path, text));
            yield* Effect.promise(() =>
              bucket.put(
                key,
                Schema.encodeSync(Schema.fromJsonString(StoredRun))({
                  ...historical,
                  sourceHash: hash,
                  language,
                }),
                {
                  customMetadata: Schema.encodeSync(StoredRunMetadata)({
                    ...metadata,
                    summary: { ...metadata.summary, sourceHash: hash, language, status: "failed" },
                  }),
                },
              ),
            );
            expect((yield* migrate()).status).toBe(200);
            const retained = yield* Effect.promise(() => bucket.get(path));
            if (retained === null) return yield* Effect.die("Missing retained runtime source");
            expect(retained.customMetadata?.format).toBe("historical-source-text-v1");
            expect(yield* Effect.promise(() => retained.text())).toBe(text);
            expect(
              (yield* client.action(id, { op: "process.get", id: "historical" })).language,
            ).toBe(language);
          }
        }),
      ).pipe(Effect.provide(FetchHttpClient.layer)),
    ),
  15000,
);
