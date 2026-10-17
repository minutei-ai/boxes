import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Effect, Redacted, Schema, Struct } from "effect";
import { FetchHttpClient } from "effect/http";
import {
  CronMigrationInput,
  CronMigrationReceipt,
  OutputMigrationInput,
  OutputMigrationReceipt,
  ProcessDescription,
  StoredRun,
  StoredRunMetadata,
  StoredCron,
  StoredCronMetadata,
} from "../src/contracts";
import { make } from "../src/sdk";
import { runtime } from "../tooling/worker-test";

const PreviousRun = StoredRun.mapFields((fields) => Struct.omit(fields, ["context"]));
const PreviousRunMetadata = StoredRunMetadata.mapFields((fields) => ({
  ...fields,
  format: Schema.Literal("run-v6"),
  summary: Schema.fromJsonString(
    ProcessDescription.mapFields((fields) => Struct.omit(fields, ["context"])),
  ),
}));
const PreviousCron = StoredCron.mapFields((fields) => Struct.omit(fields, ["context"]));
const PreviousCronMetadata = StoredCronMetadata.mapFields((fields) => ({
  ...fields,
  format: Schema.Literal("cron-v1"),
}));

test(
  "context cutover migrates v6 processes and paginated v1 schedules, fences old writes and skips converted bodies",
  () =>
    Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const directory = yield* Effect.acquireRelease(
            Effect.promise(() => mkdtemp(join(tmpdir(), "boxes-context-cutover-"))),
            (path) => Effect.promise(() => rm(path, { recursive: true, force: true })),
          );
          const worker = yield* Effect.acquireRelease(
            Effect.sync(() => runtime(directory, { controlled: false })),
            (worker) => Effect.promise(() => worker.dispose()),
          );
          const url = (yield* Effect.promise(() => worker.ready)).toString();
          const admin = yield* make({ url, token: Redacted.make("cirro-local-test-credential") });
          yield* admin.create({
            id: "cutover",
            policy: {
              networkHosts: [],
              interruptBudget: 1000,
              memoryBytes: 8388608,
              maxOutputBytes: 1048576,
            },
          });
          const grant = yield* admin.mintCapability("cutover", {
            permissions: ["read", "write", "execute", "manage"],
            expiresInSeconds: 3600,
          });
          const boxes = yield* make({ url, token: Redacted.make(grant.token) });
          yield* boxes.action("cutover", {
            op: "process.spawn",
            execution: { op: "javascript.evaluate", id: "pending", expression: "42" },
          });
          const objects = yield* Effect.promise(() => worker.objects);
          const processKey = "processes/cutover/pending.json";
          const process = yield* Effect.promise(() => objects.get(processKey));
          if (process === null) return yield* Effect.die("Missing process");
          const run = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(StoredRun))(
            yield* Effect.promise(() => process.text()),
          );
          const metadata = yield* Schema.decodeUnknownEffect(StoredRunMetadata)(
            process.customMetadata,
          );
          const previousProcess = yield* Effect.promise(() =>
            objects.put(
              processKey,
              Schema.encodeSync(Schema.fromJsonString(PreviousRun))(Struct.omit(run, ["context"])),
              {
                customMetadata: Schema.encodeSync(PreviousRunMetadata)({
                  format: "run-v6",
                  summary: Struct.omit(metadata.summary, ["context"]),
                }),
              },
            ),
          );
          if (previousProcess === null) return yield* Effect.die("Missing old process receipt");
          const request = Effect.fn("contextMigrationTest.request")(function* (
            path: string,
            body: string,
            token = "cirro-local-test-credential",
          ) {
            const response = yield* Effect.promise(() =>
              fetch(new URL(path, url), {
                method: "POST",
                headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
                body,
                keepalive: false,
              }),
            );
            return { status: response.status, text: yield* Effect.promise(() => response.text()) };
          });
          expect(
            yield* boxes
              .action("cutover", { op: "process.get", id: "pending" })
              .pipe(Effect.result),
          ).toMatchObject({ _tag: "Failure" });
          const converted = yield* request(
            "/v1/migrations/process-index-v7",
            Schema.encodeSync(Schema.fromJsonString(OutputMigrationInput))({}),
          );
          expect(converted.status).toBe(200);
          expect(
            Schema.decodeUnknownSync(Schema.fromJsonString(OutputMigrationReceipt))(converted.text),
          ).toEqual({ migrated: 1, cursor: null });
          const current = yield* Effect.promise(() => objects.get(processKey));
          if (current === null) return yield* Effect.die("Lost process");
          expect(
            Schema.decodeUnknownSync(Schema.fromJsonString(StoredRun))(
              yield* Effect.promise(() => current.text()),
            ),
          ).toEqual(run);
          expect(
            yield* Effect.promise(() =>
              objects.put(processKey, "stale", { onlyIf: { etagMatches: previousProcess.etag } }),
            ),
          ).toBeNull();
          const original = yield* Effect.forEach(
            Array.from({ length: 52 }, (_, index) => `job-${String(index).padStart(2, "0")}`),
            (id) =>
              Effect.gen(function* () {
                yield* boxes.action("cutover", {
                  op: "cron.schedule",
                  id,
                  schedule: "* * * * *",
                  overlap: "queue",
                  execution: { op: "javascript.evaluate", id: "run", expression: "42" },
                });
                const key = `schedules/cutover/${id}.json`;
                const object = yield* Effect.promise(() => objects.get(key));
                if (object === null) return yield* Effect.die("Missing schedule");
                const record = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(StoredCron))(
                  yield* Effect.promise(() => object.text()),
                );
                const saved = yield* Effect.promise(() =>
                  objects.put(
                    key,
                    Schema.encodeSync(Schema.fromJsonString(PreviousCron))(
                      Struct.omit(record, ["context"]),
                    ),
                    {
                      customMetadata: Schema.encodeSync(PreviousCronMetadata)({
                        format: "cron-v1",
                        summary: Struct.pick(record, ["state", "nextRun"]),
                      }),
                    },
                  ),
                );
                if (saved === null) return yield* Effect.die("Missing old schedule receipt");
                return { key, record, etag: saved.etag };
              }),
            { concurrency: 4 },
          );
          expect(
            yield* boxes.action("cutover", { op: "cron.get", id: "job-00" }).pipe(Effect.result),
          ).toMatchObject({ _tag: "Failure" });
          const encoded = Schema.encodeSync(Schema.fromJsonString(CronMigrationInput))({});
          expect(
            (yield* request("/v1/migrations/cron-contexts-v2", encoded, grant.token)).status,
          ).toBe(401);
          const first = yield* request("/v1/migrations/cron-contexts-v2", encoded);
          expect(first.status).toBe(200);
          const page = Schema.decodeUnknownSync(Schema.fromJsonString(CronMigrationReceipt))(
            first.text,
          );
          expect(page.migrated).toBe(50);
          expect(page.cursor).not.toBeNull();
          const repeated = yield* request("/v1/migrations/cron-contexts-v2", encoded);
          expect(
            Schema.decodeUnknownSync(Schema.fromJsonString(CronMigrationReceipt))(repeated.text)
              .migrated,
          ).toBe(0);
          const last = yield* request(
            "/v1/migrations/cron-contexts-v2",
            Schema.encodeSync(Schema.fromJsonString(CronMigrationInput))({ cursor: page.cursor }),
          );
          expect(
            Schema.decodeUnknownSync(Schema.fromJsonString(CronMigrationReceipt))(last.text),
          ).toEqual({ migrated: 2, cursor: null });
          for (const entry of original) {
            const object = yield* Effect.promise(() => objects.get(entry.key));
            if (object === null) return yield* Effect.die("Lost schedule");
            expect(
              Schema.decodeUnknownSync(Schema.fromJsonString(StoredCron))(
                yield* Effect.promise(() => object.text()),
              ),
            ).toEqual(entry.record);
            expect(object.customMetadata?.format).toBe("cron-v2");
            expect(
              yield* Effect.promise(() =>
                objects.put(entry.key, "stale", { onlyIf: { etagMatches: entry.etag } }),
              ),
            ).toBeNull();
          }
        }),
      ).pipe(
        Effect.provide(FetchHttpClient.layer),
        Effect.provideService(FetchHttpClient.RequestInit, { keepalive: false }),
      ),
    ),
  15000,
);
