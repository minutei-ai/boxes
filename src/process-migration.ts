import { Effect, Schema, Struct } from "effect";
import { RunRecord, RunMetadata, StoredRun, StoredRunMetadata, Id, Capability } from "./contracts";
import { StorageFailure } from "./storage";
import type { Env } from "./resources";
import { archiveOutput } from "./output";

export const migrateProcesses = Effect.fn("migration.processReceipts")(function* (env: Env) {
  const cursors: (string | undefined)[] = [undefined];
  const migrated = { count: 0 };
  while (cursors.length > 0) {
    const cursor = cursors.shift();
    const page = yield* Effect.tryPromise({
      try: () => env.OBJECTS.list({ prefix: "sandboxes/", cursor, limit: 1000 }),
      catch: (cause) => new StorageFailure({ cause }),
    });
    yield* Effect.forEach(
      page.objects.filter(
        (object) => object.key.includes("/runs/") && object.key.endsWith(".json"),
      ),
      (object) =>
        Effect.gen(function* () {
          const parts = object.key.split("/");
          const stored = yield* Effect.tryPromise({
            try: () => env.OBJECTS.get(object.key),
            catch: (cause) => new StorageFailure({ cause }),
          });
          if (stored === null || stored.size > 8_388_608)
            return yield* new StorageFailure({ cause: object.key });
          const text = yield* Effect.tryPromise({
            try: () => stored.text(),
            catch: (cause) => new StorageFailure({ cause }),
          });
          const record = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(RunRecord))(text);
          const sandboxId = yield* Schema.decodeUnknownEffect(Id)(parts[1]);
          if (
            parts.length !== 4 ||
            parts[0] !== "sandboxes" ||
            parts[2] !== "runs" ||
            parts[3] !== `${record.id}.json`
          )
            return yield* new StorageFailure({
              cause: "Legacy process key does not match its identity",
            });
          const key = `processes/${sandboxId}/${record.id}.json`;
          if (record.status === "queued")
            return yield* new StorageFailure({
              cause: "Legacy queued receipt lacks durable authority",
            });
          const output = yield* Effect.gen(function* () {
            if (record.output === null) return null;
            return yield* archiveOutput(env, sandboxId, record.output, null);
          });
          const encoded = Schema.encodeSync(Schema.fromJsonString(StoredRun))({
            ...record,
            output,
            authority: null,
            deadlineAt: null,
            stdinMode: "closed",
          });
          const fenced = yield* Effect.tryPromise({
            try: () =>
              env.OBJECTS.put(
                object.key,
                Schema.encodeSync(Schema.fromJsonString(InlineRun))({
                  ...record,
                  authority: null,
                  deadlineAt: null,
                }),
                { onlyIf: { etagMatches: stored.etag } },
              ),
            catch: (cause) => new StorageFailure({ cause }),
          });
          if (fenced === null)
            return yield* new StorageFailure({
              cause: `Process changed during migration: ${object.key}`,
            });
          const current = yield* Effect.tryPromise({
            try: () =>
              env.OBJECTS.put(key, encoded, {
                onlyIf: { etagDoesNotMatch: "*" },
                customMetadata: Schema.encodeSync(StoredRunMetadata)({
                  format: "run-v4",
                  summary: Struct.omit(record, ["output"]),
                }),
              }),
            catch: (cause) => new StorageFailure({ cause }),
          });
          if (current === null) {
            const target = yield* Effect.tryPromise({
              try: () => env.OBJECTS.get(key),
              catch: (cause) => new StorageFailure({ cause }),
            });
            if (target === null) return yield* new StorageFailure({ cause: key });
            const targetText = yield* Effect.tryPromise({
              try: () => target.text(),
              catch: (cause) => new StorageFailure({ cause }),
            });
            if (targetText !== encoded)
              return yield* new StorageFailure({
                cause: `Process migration target differs: ${key}`,
              });
          }
          yield* Effect.tryPromise({
            try: () => env.OBJECTS.delete(object.key),
            catch: (cause) => new StorageFailure({ cause }),
          });
          migrated.count += 1;
        }),
      { concurrency: 4 },
    );
    if (page.truncated) cursors.push(page.cursor);
  }
  return { migrated: migrated.count };
});

const InlineRun = RunRecord.mapFields((fields) => ({
  ...fields,
  authority: Schema.NullOr(Capability),
  deadlineAt: Schema.NullOr(Schema.Int),
}));
const InlineMetadata = RunMetadata.mapFields((fields) => ({
  ...fields,
  format: Schema.Literal("run-v2"),
}));
const PreviousStoredRun = StoredRun.mapFields((fields) => Struct.omit(fields, ["stdinMode"]));
const PreviousMetadata = StoredRunMetadata.mapFields((fields) => ({
  ...fields,
  format: Schema.Literal("run-v3"),
}));
const MigrationMetadata = Schema.Union([StoredRunMetadata, PreviousMetadata, InlineMetadata]);

export const migrateOutput = Effect.fn("migration.outputChunks")(function* (env: Env) {
  const cursors: (string | undefined)[] = [undefined];
  const progress = { migrated: 0 };
  while (cursors.length > 0) {
    const cursor = cursors.shift();
    const page = yield* Effect.tryPromise({
      try: () =>
        env.OBJECTS.list({
          prefix: "processes/",
          cursor,
          limit: 1000,
          include: ["customMetadata"],
        }),
      catch: (cause) => new StorageFailure({ cause }),
    });
    yield* Effect.forEach(
      page.objects,
      (object) =>
        Effect.gen(function* () {
          const metadata = yield* Schema.decodeUnknownEffect(MigrationMetadata)(
            object.customMetadata,
          );
          if (metadata.format === "run-v4") return;
          const parts = object.key.split("/");
          const sandboxId = yield* Schema.decodeUnknownEffect(Id)(parts[1]);
          if (
            parts.length !== 3 ||
            parts[0] !== "processes" ||
            parts[2] !== `${metadata.summary.id}.json`
          )
            return yield* new StorageFailure({
              cause: "Process migration key does not match its identity",
            });
          const stored = yield* Effect.tryPromise({
            try: () => env.OBJECTS.get(object.key, { onlyIf: { etagMatches: object.etag } }),
            catch: (cause) => new StorageFailure({ cause }),
          });
          if (stored === null || !("body" in stored) || stored.size > 8_388_608)
            return yield* new StorageFailure({ cause: "Process changed during output migration" });
          const text = yield* Effect.tryPromise({
            try: () => stored.text(),
            catch: (cause) => new StorageFailure({ cause }),
          });
          const converted = yield* Effect.gen(function* () {
            if (metadata.format === "run-v3") {
              const record = yield* Schema.decodeUnknownEffect(
                Schema.fromJsonString(PreviousStoredRun),
              )(text);
              return { ...record, stdinMode: "closed" as const };
            }
            const record = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(InlineRun))(
              text,
            );
            const output = yield* Effect.gen(function* () {
              if (record.output === null) return null;
              return yield* archiveOutput(env, sandboxId, record.output, null);
            });
            return { ...record, output, stdinMode: "closed" as const };
          });
          if (converted.id !== metadata.summary.id)
            return yield* new StorageFailure({ cause: "Process body does not match its identity" });
          const receipt = yield* Effect.tryPromise({
            try: () =>
              env.OBJECTS.put(
                object.key,
                Schema.encodeSync(Schema.fromJsonString(StoredRun))(converted),
                {
                  onlyIf: { etagMatches: stored.etag },
                  customMetadata: Schema.encodeSync(StoredRunMetadata)({
                    format: "run-v4",
                    summary: Struct.omit(converted, [
                      "output",
                      "authority",
                      "deadlineAt",
                      "stdinMode",
                    ]),
                  }),
                },
              ),
            catch: (cause) => new StorageFailure({ cause }),
          });
          if (receipt === null)
            return yield* new StorageFailure({ cause: "Process changed during output migration" });
          progress.migrated += 1;
        }),
      { concurrency: 4 },
    );
    if (page.truncated) cursors.push(page.cursor);
  }
  return progress;
});
