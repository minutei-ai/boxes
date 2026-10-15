import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { Effect, Fiber, Redacted, Schedule, Schema, Struct } from "effect";
import { FetchHttpClient } from "effect/http";
import { make } from "../src/sdk";
import {
  StoredRun,
  StoredRunMetadata,
  ProcessDelivery,
  ProcessDeadlineMigrationInput,
  ProcessDeadlineMigrationReceipt,
  DispatchReceipt,
} from "../src/contracts";
import { runtime } from "../tooling/worker-test";

test("inline reservations retain a recovery deadline while their execution is active", () =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const directory = yield* Effect.acquireRelease(
          Effect.promise(() => mkdtemp("/tmp/boxes-inline-deadline-")),
          (path) => Effect.promise(() => rm(path, { recursive: true, force: true })),
        );
        const worker = yield* Effect.acquireRelease(
          Effect.sync(() =>
            runtime(directory, {
              controlled: false,
              origin: { delay: 500, body: "confirmed native response" },
            }),
          ),
          (worker) => Effect.promise(() => worker.dispose()),
        );
        const url = (yield* Effect.promise(() => worker.ready)).toString();
        const admin = yield* make({ url, token: Redacted.make("cirro-local-test-credential") });
        yield* admin.create({
          id: "inline",
          policy: {
            networkHosts: ["allowed.example"],
            interruptBudget: 1000,
            memoryBytes: 8388608,
            maxOutputBytes: 1048576,
          },
        });
        const grant = yield* admin.mintCapability("inline", {
          permissions: ["read", "execute", "network"],
          expiresInSeconds: 3600,
        });
        const client = yield* make({ url, token: Redacted.make(grant.token) });
        const running = yield* client
          .action("inline", {
            op: "process.run",
            id: "pending",
            language: "javascript",
            source:
              'export default async ({tools}) => { await tools.call({op:"network.fetch",url:"https://allowed.example/slow"}); return 42; }',
          })
          .pipe(Effect.forkChild);
        const objects = yield* Effect.promise(() => worker.objects);
        const active = yield* Effect.gen(function* () {
          const object = yield* Effect.promise(() => objects.get("processes/inline/pending.json"));
          if (object === null) return null;
          return yield* Schema.decodeUnknownEffect(Schema.fromJsonString(StoredRun))(
            yield* Effect.promise(() => object.text()),
          );
        }).pipe(
          Effect.repeat({
            until: (record) => record !== null,
            schedule: Schedule.spaced("1 millis"),
          }),
          Effect.timeout("5 seconds"),
        );
        const completed = yield* Fiber.join(running);
        expect(completed.status).toBe("exited");
        expect(completed.output?.result).toBe(42);
        expect(active).not.toBeNull();
        if (active === null) return;
        expect(active.status).toBe("running");
        expect(active.deadlineAt).toBe(active.startedAt + 900000);
        expect(active.authority).toBeNull();
        expect(active.checkpoint).toBeNull();
        const settled = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(StoredRun))(
          yield* Effect.promise(async () => {
            const object = await objects.get("processes/inline/pending.json");
            if (object === null) return "null";
            return object.text();
          }),
        );
        expect(settled.deadlineAt).toBeNull();
      }),
    ).pipe(
      Effect.provide(FetchHttpClient.layer),
      Effect.provideService(FetchHttpClient.RequestInit, { keepalive: false }),
    ),
  ));

test(
  "deadline migration survives replacement and recovers retained inline effects without replay",
  () =>
    Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const directory = yield* Effect.acquireRelease(
            Effect.promise(() => mkdtemp("/tmp/boxes-inline-cutover-")),
            (path) => Effect.promise(() => rm(path, { recursive: true, force: true })),
          );
          const first = yield* Effect.acquireRelease(
            Effect.sync(() => runtime(directory)),
            (worker) => Effect.promise(() => worker.dispose()),
          );
          const url = (yield* Effect.promise(() => first.ready)).toString();
          const admin = yield* make({ url, token: Redacted.make("cirro-local-test-credential") });
          yield* admin.create({
            id: "legacy",
            policy: {
              networkHosts: [],
              interruptBudget: 1000,
              memoryBytes: 8388608,
              maxOutputBytes: 1048576,
            },
          });
          const grant = yield* admin.mintCapability("legacy", {
            permissions: ["read", "write", "execute", "manage"],
            expiresInSeconds: 3600,
          });
          const client = yield* make({ url, token: Redacted.make(grant.token) });
          yield* client.action("legacy", {
            op: "filesystem.writeFile",
            path: "/counter",
            content: "",
            encoding: "utf8",
          });
          const source =
            'export default async ({tools,console}) => { await tools.call({op:"filesystem.appendFile",path:"/counter",content:"A"}); console.log("acknowledged"); return 42; }';
          const seedRun = yield* client.action("legacy", {
            op: "process.run",
            id: "seed",
            language: "javascript",
            source,
          });
          expect(seedRun.status).toBe("exited");
          yield* client.action("legacy", {
            op: "process.spawn",
            execution: { op: "process.run", id: "queued", language: "javascript", source },
          });
          const objects = yield* Effect.promise(() => first.objects);
          const object = yield* Effect.promise(() => objects.get("processes/legacy/seed.json"));
          if (object === null) return yield* Effect.die("Native seed receipt is missing");
          const seed = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(StoredRun))(
            yield* Effect.promise(() => object.text()),
          );
          if (seed.output === null) return yield* Effect.die("Native seed output is missing");
          const partial = { ...seed.output, result: null, exitCode: null };
          const originals = yield* Effect.forEach(
            Array.from({ length: 51 }, (_, index) => index),
            (index) =>
              Effect.gen(function* () {
                const status = yield* Effect.sync(() => {
                  if (index === 1) return "cancelling" as const;
                  return "running" as const;
                });
                const record = {
                  ...seed,
                  id: `lost-${String(index).padStart(3, "0")}`,
                  status,
                  startedAt: first.time - 901000,
                  finishedAt: null,
                  output: partial,
                  deadlineAt: null,
                };
                const saved = yield* Effect.promise(() =>
                  objects.put(
                    `processes/legacy/${record.id}.json`,
                    Schema.encodeSync(Schema.fromJsonString(StoredRun))(record),
                    {
                      customMetadata: Schema.encodeSync(StoredRunMetadata)({
                        format: "run-v5",
                        summary: Struct.omit(record, [
                          "output",
                          "authority",
                          "deadlineAt",
                          "stdinMode",
                          "checkpoint",
                          "checkpointCount",
                        ]),
                      }),
                    },
                  ),
                );
                if (saved === null) return yield* Effect.die("Native orphan seed was not saved");
                return { record, etag: saved.etag };
              }),
            { concurrency: 4 },
          );
          const future = {
            ...seed,
            id: "future",
            status: "running" as const,
            startedAt: first.time,
            finishedAt: null,
            output: partial,
            deadlineAt: first.time + 900000,
          };
          yield* Effect.promise(() =>
            objects.put(
              "processes/legacy/future.json",
              Schema.encodeSync(Schema.fromJsonString(StoredRun))(future),
              {
                customMetadata: Schema.encodeSync(StoredRunMetadata)({
                  format: "run-v5",
                  summary: Struct.omit(future, [
                    "output",
                    "authority",
                    "deadlineAt",
                    "stdinMode",
                    "checkpoint",
                    "checkpointCount",
                  ]),
                }),
              },
            ),
          );
          const before = yield* Effect.forEach(["seed", "queued", "future"], (id) =>
            Effect.promise(() => objects.head(`processes/legacy/${id}.json`)),
          );
          const forbidden = yield* Effect.promise(() =>
            fetch(new URL("/v1/migrations/process-deadlines-v1", url), {
              method: "POST",
              keepalive: false,
              headers: { authorization: `Bearer ${grant.token}` },
              body: "{}",
            }),
          );
          expect(forbidden.status).toBe(401);
          yield* Effect.promise(() => forbidden.arrayBuffer());
          const invalid = yield* Effect.promise(() =>
            fetch(new URL("/v1/migrations/process-deadlines-v1", url), {
              method: "POST",
              keepalive: false,
              headers: { authorization: "Bearer cirro-local-test-credential" },
              body: '{"cursor":null,"ignored":true}',
            }),
          );
          expect(invalid.status).toBe(400);
          yield* Effect.promise(() => invalid.arrayBuffer());
          const migrated = yield* Effect.promise(() =>
            fetch(new URL("/v1/migrations/process-deadlines-v1", url), {
              method: "POST",
              keepalive: false,
              headers: { authorization: "Bearer cirro-local-test-credential" },
              body: Schema.encodeSync(Schema.fromJsonString(ProcessDeadlineMigrationInput))({
                cursor: null,
              }),
            }),
          );
          expect(migrated.status).toBe(200);
          const page = yield* Schema.decodeUnknownEffect(ProcessDeadlineMigrationReceipt)(
            yield* Effect.promise(() => migrated.json()),
          );
          expect(page.cursor).not.toBeNull();
          yield* Effect.promise(() => first.dispose());
          const second = yield* Effect.acquireRelease(
            Effect.sync(() => runtime(directory, { clockStart: first.time + 900001 })),
            (worker) => Effect.promise(() => worker.dispose()),
          );
          const replacementUrl = (yield* Effect.promise(() => second.ready)).toString();
          const replacement = yield* make({
            url: replacementUrl,
            token: Redacted.make(grant.token),
          });
          const next = yield* Effect.promise(() =>
            fetch(new URL("/v1/migrations/process-deadlines-v1", replacementUrl), {
              method: "POST",
              keepalive: false,
              headers: { authorization: "Bearer cirro-local-test-credential" },
              body: Schema.encodeSync(Schema.fromJsonString(ProcessDeadlineMigrationInput))({
                cursor: page.cursor,
              }),
            }),
          );
          expect(next.status).toBe(200);
          const continued = yield* Schema.decodeUnknownEffect(ProcessDeadlineMigrationReceipt)(
            yield* Effect.promise(() => next.json()),
          );
          expect(continued.cursor).toBeNull();
          expect(page.migrated + continued.migrated).toBe(51);
          const repeated = yield* Effect.promise(() =>
            fetch(new URL("/v1/migrations/process-deadlines-v1", replacementUrl), {
              method: "POST",
              keepalive: false,
              headers: { authorization: "Bearer cirro-local-test-credential" },
              body: Schema.encodeSync(Schema.fromJsonString(ProcessDeadlineMigrationInput))({
                cursor: null,
              }),
            }),
          );
          const repeatPage = yield* Schema.decodeUnknownEffect(ProcessDeadlineMigrationReceipt)(
            yield* Effect.promise(() => repeated.json()),
          );
          expect(repeatPage.migrated).toBe(0);
          const retained = yield* Effect.promise(() => second.objects);
          const unchanged = yield* Effect.forEach(["seed", "queued", "future"], (id) =>
            Effect.promise(() => retained.head(`processes/legacy/${id}.json`)),
          );
          expect(unchanged.map((object) => object?.etag)).toEqual(
            before.map((object) => object?.etag),
          );
          const repaired = yield* Effect.forEach(
            originals,
            ({ record, etag }) =>
              Effect.gen(function* () {
                const current = yield* Effect.promise(() =>
                  retained.get(`processes/legacy/${record.id}.json`),
                );
                if (current === null) return yield* Effect.die("Repaired receipt is missing");
                const saved = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(StoredRun))(
                  yield* Effect.promise(() => current.text()),
                );
                expect(saved.deadlineAt).toBe(saved.startedAt + 900000);
                expect(saved.output).toEqual(partial);
                expect(saved.authority).toBeNull();
                expect(current.etag).not.toBe(etag);
                return { key: current.key, eTag: current.etag };
              }),
            { concurrency: 4 },
          );
          const repair = yield* Effect.promise(() =>
            fetch(new URL("/v1/maintenance/process-dispatch", replacementUrl), {
              method: "POST",
              keepalive: false,
              headers: { authorization: "Bearer cirro-local-test-credential" },
              body: "{}",
            }),
          );
          expect(repair.status).toBe(200);
          expect(
            (yield* Schema.decodeUnknownEffect(DispatchReceipt)(
              yield* Effect.promise(() => repair.json()),
            )).notifications,
          ).toBe(52);
          const native = yield* Effect.promise(() => second.control);
          const futureObject = yield* Effect.promise(() =>
            retained.head("processes/legacy/future.json"),
          );
          if (futureObject === null) return yield* Effect.die("Future receipt is missing");
          const deliveries = [...repaired, { key: futureObject.key, eTag: futureObject.etag }];
          yield* Effect.promise(() =>
            native.deliver(
              "executions",
              deliveries.map((delivery, index) => ({
                id: String(index),
                timestamp: new Date(second.time),
                attempts: 1,
                body: Schema.encodeSync(ProcessDelivery)(delivery),
              })),
            ),
          );
          const results = yield* Effect.forEach(originals, ({ record }) =>
            Effect.gen(function* () {
              const result = yield* replacement.action("legacy", {
                op: "process.get",
                id: record.id,
              });
              expect(result.output?.stdout).toBe("acknowledged\n");
              return result.status;
            }),
          );
          expect(results.filter((status) => status === "cancelled")).toHaveLength(1);
          expect(results.filter((status) => status === "failed")).toHaveLength(50);
          expect(
            (yield* replacement.action("legacy", { op: "process.get", id: "future" })).status,
          ).toBe("failed");
          const counter = yield* replacement.action("legacy", {
            op: "filesystem.readFile",
            path: "/counter",
          });
          expect(Buffer.from(counter.content, counter.encoding).toString()).toBe("A");
          yield* replacement.action("legacy", { op: "process.cancel", id: "queued" });
          yield* replacement.action("legacy", { op: "vm.dispose" });
          const collected = yield* replacement
            .action("legacy", { op: "vm.reclaim", limit: 1000 })
            .pipe(Effect.repeat({ until: (progress) => progress.status !== "pending", times: 16 }));
          expect(collected.status).toBe("complete");
          const inconsistent = { ...future, id: "inconsistent", deadlineAt: null };
          const saved = yield* Effect.promise(() =>
            retained.put(
              "processes/legacy/inconsistent.json",
              Schema.encodeSync(Schema.fromJsonString(StoredRun))(inconsistent),
              {
                customMetadata: Schema.encodeSync(StoredRunMetadata)({
                  format: "run-v5",
                  summary: {
                    ...Struct.omit(inconsistent, [
                      "output",
                      "authority",
                      "deadlineAt",
                      "stdinMode",
                      "checkpoint",
                      "checkpointCount",
                    ]),
                    sourceHash: "0".repeat(64),
                  },
                }),
              },
            ),
          );
          const rejected = yield* Effect.promise(() =>
            fetch(new URL("/v1/migrations/process-deadlines-v1", replacementUrl), {
              method: "POST",
              keepalive: false,
              headers: { authorization: "Bearer cirro-local-test-credential" },
              body: "{}",
            }),
          );
          expect(rejected.status).toBe(500);
          yield* Effect.promise(() => rejected.arrayBuffer());
          expect(
            (yield* Effect.promise(() => retained.head("processes/legacy/inconsistent.json")))
              ?.etag,
          ).toBe(saved?.etag);
        }),
      ).pipe(
        Effect.provide(FetchHttpClient.layer),
        Effect.provideService(FetchHttpClient.RequestInit, { keepalive: false }),
      ),
    ),
  30000,
);
