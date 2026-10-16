import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Redacted, Schema, Struct } from "effect";
import { FetchHttpClient } from "effect/http";
import {
  OutputMigrationReceipt,
  RunMetadata,
  StoredRun,
  StoredRunMetadata,
} from "../src/contracts";
import { make } from "../src/sdk";
import { runtime } from "../tooling/worker-test";

const VersionFiveStoredRun = StoredRun.mapFields((fields) => ({
  ...Struct.omit(fields, ["inputMode"]),
  stdinMode: fields.inputMode,
}));
const VersionFiveMetadata = RunMetadata.mapFields((fields) => ({
  ...fields,
  format: Schema.Literal("run-v5"),
}));

test(
  "v5 process index cutover fences old writers, retains data and modes and replays without writes",
  () =>
    Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const directory = yield* Effect.acquireRelease(
            Effect.promise(() => mkdtemp(join(tmpdir(), "boxes-process-index-"))),
            (path) => Effect.promise(() => rm(path, { recursive: true, force: true })),
          );
          const worker = yield* Effect.acquireRelease(
            Effect.sync(() => runtime(directory, { controlled: false })),
            (worker) => Effect.promise(() => worker.dispose()),
          );
          const url = (yield* Effect.promise(() => worker.ready)).toString();
          const admin = yield* make({ url, token: Redacted.make("cirro-local-test-credential") });
          yield* admin.create({
            id: "index-cutover",
            policy: {
              networkHosts: [],
              interruptBudget: 1000,
              memoryBytes: 8388608,
              maxOutputBytes: 1048576,
            },
          });
          const grant = yield* admin.mintCapability("index-cutover", {
            permissions: ["read", "execute"],
            expiresInSeconds: 60,
          });
          const client = yield* make({ url, token: Redacted.make(grant.token) });
          const source = Buffer.from(
            yield* Effect.promise(() => Bun.file("dist/wasi-pty-sink.wasm").arrayBuffer()),
          ).toString("base64");
          const jobs = (
            [
              ["closed", 1],
              ["pipe", 1],
              ["pty", 51],
            ] as const
          ).flatMap(([stdinMode, count], section) =>
            Array.from({ length: count }, (_, index) => ({
              id: `${section}-${String(index).padStart(2, "0")}`,
              stdinMode,
            })),
          );
          yield* Effect.forEach(
            jobs,
            (job) =>
              client.action("index-cutover", {
                op: "process.spawn",
                stdinMode: job.stdinMode,
                execution: { op: "process.run", id: job.id, language: "wasm", source },
              }),
            { concurrency: 4 },
          );
          const objects = yield* Effect.promise(() => worker.objects);
          const original = yield* Effect.forEach(
            jobs,
            (job) =>
              Effect.gen(function* () {
                const key = `processes/index-cutover/${job.id}.json`;
                const object = yield* Effect.promise(() => objects.get(key));
                if (object === null) return yield* Effect.die("Missing native receipt");
                const record = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(StoredRun))(
                  yield* Effect.promise(() => object.text()),
                );
                const metadata = yield* Schema.decodeUnknownEffect(StoredRunMetadata)(
                  object.customMetadata,
                );
                const text = `\n  ${Schema.encodeSync(Schema.fromJsonString(VersionFiveStoredRun))({ ...Struct.omit(record, ["inputMode"]), stdinMode: record.inputMode })}\n`;
                const previous = Schema.encodeSync(VersionFiveMetadata)({
                  format: "run-v5",
                  summary: Struct.omit(metadata.summary, ["stdinMode"]),
                });
                const saved = yield* Effect.promise(() =>
                  objects.put(key, text, { customMetadata: previous }),
                );
                if (saved === null) return yield* Effect.die("Legacy receipt was not retained");
                return { key, text, record, previous, etag: saved.etag };
              }),
            { concurrency: 4 },
          );
          expect(
            yield* client
              .action("index-cutover", { op: "process.list", limit: 50, cursor: null })
              .pipe(Effect.result),
          ).toMatchObject({ _tag: "Failure" });
          const control = yield* Effect.promise(() => worker.control);
          const denied = yield* Effect.promise(() =>
            control.migrateProcessIndex(grant.token, null),
          );
          expect(denied).toMatchObject({ status: 401, writes: 0, notifications: 0 });
          const first = yield* Effect.promise(() =>
            control.migrateProcessIndex("cirro-local-test-credential", null),
          );
          expect(first).toMatchObject({ status: 200, writes: 50, notifications: 50 });
          const firstPage = yield* Schema.decodeUnknownEffect(
            Schema.fromJsonString(OutputMigrationReceipt),
          )(first.body);
          expect(firstPage.migrated).toBe(50);
          expect(firstPage.cursor).not.toBeNull();
          const repeated = yield* Effect.promise(() =>
            control.migrateProcessIndex("cirro-local-test-credential", null),
          );
          expect(repeated).toMatchObject({ status: 200, writes: 0, notifications: 0 });
          const replay = yield* Schema.decodeUnknownEffect(
            Schema.fromJsonString(OutputMigrationReceipt),
          )(repeated.body);
          expect(replay.migrated).toBe(0);
          if (replay.cursor === null) return yield* Effect.die("Migration lost its continuation");
          const last = yield* Effect.promise(() =>
            control.migrateProcessIndex("cirro-local-test-credential", replay.cursor),
          );
          expect(last).toMatchObject({ status: 200, writes: 3, notifications: 3 });
          expect(
            yield* Schema.decodeUnknownEffect(Schema.fromJsonString(OutputMigrationReceipt))(
              last.body,
            ),
          ).toEqual({ migrated: 3, cursor: null });
          for (const retained of original) {
            const object = yield* Effect.promise(() => objects.get(retained.key));
            if (object === null) return yield* Effect.die("Migrated receipt disappeared");
            const migratedText = yield* Effect.promise(() => object.text());
            expect(object.etag).not.toBe(retained.etag);
            expect(
              yield* Schema.decodeUnknownEffect(Schema.fromJsonString(StoredRun))(migratedText),
            ).toEqual(retained.record);
            expect(
              yield* Schema.decodeUnknownEffect(Schema.fromJsonString(VersionFiveStoredRun))(
                migratedText,
              ).pipe(Effect.result),
            ).toMatchObject({ _tag: "Failure" });
            const metadata = yield* Schema.decodeUnknownEffect(StoredRunMetadata)(
              object.customMetadata,
            );
            expect(metadata.format).toBe("run-v6");
            expect(metadata.summary.stdinMode).toBe(retained.record.inputMode);
            expect(Struct.omit(metadata.summary, ["stdinMode"])).toEqual(
              Struct.omit(retained.record, [
                "output",
                "authority",
                "deadlineAt",
                "inputMode",
                "checkpoint",
                "checkpointCount",
              ]),
            );
            if (retained.key.endsWith("/0-00.json")) {
              const stale = yield* Effect.promise(() =>
                objects.put(retained.key, retained.text, {
                  onlyIf: { etagMatches: retained.etag },
                  customMetadata: retained.previous,
                }),
              );
              expect(stale).toBeNull();
            }
          }
          const complete = yield* Effect.promise(() =>
            control.migrateProcessIndex("cirro-local-test-credential", replay.cursor),
          );
          expect(complete).toMatchObject({ status: 200, writes: 0, notifications: 0 });
          const malformed = original[0];
          yield* Effect.promise(() =>
            objects.put(malformed.key, malformed.text, {
              customMetadata: Schema.encodeSync(VersionFiveMetadata)({
                format: "run-v5",
                summary: {
                  ...Struct.omit(malformed.record, [
                    "output",
                    "authority",
                    "deadlineAt",
                    "inputMode",
                    "checkpoint",
                    "checkpointCount",
                  ]),
                  status: "exited",
                },
              }),
            }),
          );
          const failed = yield* Effect.promise(() =>
            control.migrateProcessIndex("cirro-local-test-credential", null),
          );
          expect(failed).toMatchObject({ status: 500, writes: 0, notifications: 0 });
          const unchanged = yield* Effect.promise(() => objects.get(malformed.key));
          if (unchanged === null) return yield* Effect.die("Rejected receipt disappeared");
          expect(yield* Effect.promise(() => unchanged.text())).toBe(malformed.text);
          expect(unchanged.customMetadata?.format).toBe("run-v5");
        }),
      ).pipe(
        Effect.provide(FetchHttpClient.layer),
        Effect.provideService(FetchHttpClient.RequestInit, { keepalive: false }),
      ),
    ),
  10000,
);
