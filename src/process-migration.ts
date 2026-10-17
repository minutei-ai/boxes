import { Effect, Schema, Struct } from "effect";
import {
  RunRecord,
  RunSummary,
  ProcessDescription,
  RunMetadata,
  StoredRun,
  StoredRunMetadata,
  Id,
  Capability,
  ProcessDelivery,
} from "./contracts";
import { StorageFailure } from "./storage";
import type { Env } from "./resources";
import { archiveOutput } from "./output";
import { executionWindowMs, QueueFailure } from "./process";

export const PreviousRunRecord = RunRecord.mapFields((fields) => Struct.omit(fields, ["context"]));
const PreviousRunSummary = RunSummary.mapFields((fields) => Struct.omit(fields, ["context"]));
export const PreviousRunMetadata = RunMetadata.mapFields((fields) => ({
  ...fields,
  summary: Schema.fromJsonString(PreviousRunSummary),
}));
const VersionSixStoredRun = StoredRun.mapFields((fields) => Struct.omit(fields, ["context"]));
const VersionSixMetadata = StoredRunMetadata.mapFields((fields) => ({
  ...fields,
  format: Schema.Literal("run-v6"),
  summary: Schema.fromJsonString(
    ProcessDescription.mapFields((fields) => Struct.omit(fields, ["context"])),
  ),
}));

export const migrateDeadlines = Effect.fn("migration.processDeadlines")(function* (
  env: Env,
  cursor: string | null,
) {
  const progress = { migrated: 0 };
  const page = yield* Effect.tryPromise({
    try: () =>
      env.OBJECTS.list({
        prefix: "processes/",
        cursor: cursor ?? undefined,
        limit: 50,
        include: ["customMetadata"],
      }),
    catch: (cause) => new StorageFailure({ cause }),
  });
  yield* Effect.forEach(
    page.objects,
    (object) =>
      Effect.gen(function* () {
        const metadata = yield* Schema.decodeUnknownEffect(StoredRunMetadata)(
          object.customMetadata,
        );
        if (metadata.summary.status !== "running" && metadata.summary.status !== "cancelling")
          return;
        const parts = object.key.split("/");
        const sandboxId = yield* Schema.decodeUnknownEffect(Id)(parts[1]);
        if (
          parts.length !== 3 ||
          object.key !== `processes/${sandboxId}/${metadata.summary.id}.json`
        )
          return yield* new StorageFailure({
            cause: "Deadline migration process identity mismatch",
          });
        const stored = yield* Effect.tryPromise({
          try: () => env.OBJECTS.get(object.key, { onlyIf: { etagMatches: object.etag } }),
          catch: (cause) => new StorageFailure({ cause }),
        });
        if (stored === null || !("body" in stored) || stored.size > 8_388_608)
          return yield* new StorageFailure({ cause: "Process changed during deadline migration" });
        const text = yield* Effect.tryPromise({
          try: () => stored.text(),
          catch: (cause) => new StorageFailure({ cause }),
        });
        const record = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(StoredRun))(text);
        const summary = {
          ...Struct.omit(record, [
            "output",
            "authority",
            "deadlineAt",
            "inputMode",
            "checkpoint",
            "checkpointCount",
          ]),
          stdinMode: record.inputMode,
        };
        if (!Schema.toEquivalence(StoredRunMetadata.fields.summary)(metadata.summary, summary))
          return yield* new StorageFailure({
            cause: "Deadline migration metadata does not match the receipt",
          });
        if (record.deadlineAt !== null) return;
        const updated = { ...record, deadlineAt: record.startedAt + executionWindowMs };
        const saved = yield* Effect.tryPromise({
          try: () =>
            env.OBJECTS.put(
              object.key,
              Schema.encodeSync(Schema.fromJsonString(StoredRun))(updated),
              {
                onlyIf: { etagMatches: stored.etag },
                customMetadata: Schema.encodeSync(StoredRunMetadata)(metadata),
              },
            ),
          catch: (cause) => new StorageFailure({ cause }),
        });
        if (saved === null)
          return yield* new StorageFailure({
            cause: "Process changed during deadline publication",
          });
        progress.migrated += 1;
      }),
    { concurrency: 4 },
  );
  if (page.truncated) return { migrated: progress.migrated, cursor: page.cursor };
  return { migrated: progress.migrated, cursor: null };
});

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
          const record = yield* Schema.decodeUnknownEffect(
            Schema.fromJsonString(PreviousRunRecord),
          )(text);
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
            context: null,
            output,
            authority: null,
            deadlineAt: null,
            inputMode: "closed",
            checkpoint: null,
            checkpointCount: 0,
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
                  format: "run-v7",
                  summary: {
                    ...Struct.omit(record, ["output"]),
                    context: null,
                    stdinMode: "closed",
                  },
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

const InlineRun = PreviousRunRecord.mapFields((fields) => ({
  ...fields,
  authority: Schema.NullOr(Capability),
  deadlineAt: Schema.NullOr(Schema.Int),
}));
const InlineMetadata = PreviousRunMetadata.mapFields((fields) => ({
  ...fields,
  format: Schema.Literal("run-v2"),
}));
const VersionFiveStoredRun = VersionSixStoredRun.mapFields((fields) => ({
  ...Struct.omit(fields, ["inputMode"]),
  stdinMode: fields.inputMode,
}));
const PreviousStoredRun = VersionFiveStoredRun.mapFields((fields) =>
  Struct.omit(fields, ["stdinMode", "checkpoint", "checkpointCount"]),
);
const PreviousMetadata = PreviousRunMetadata.mapFields((fields) => ({
  ...fields,
  format: Schema.Literal("run-v3"),
}));
const VersionFourStoredRun = VersionFiveStoredRun.mapFields((fields) =>
  Struct.omit(fields, ["checkpoint", "checkpointCount"]),
);
const VersionFourMetadata = PreviousRunMetadata.mapFields((fields) => ({
  ...fields,
  format: Schema.Literal("run-v4"),
}));
const VersionFiveMetadata = PreviousRunMetadata.mapFields((fields) => ({
  ...fields,
  format: Schema.Literal("run-v5"),
}));
const MigrationMetadata = Schema.Union([
  StoredRunMetadata,
  VersionSixMetadata,
  VersionFiveMetadata,
  VersionFourMetadata,
  PreviousMetadata,
  InlineMetadata,
]);

export const migrateOutput = Effect.fn("migration.processIndex")(function* (
  env: Env,
  cursor: string | null,
) {
  const progress = { migrated: 0 };
  const page = yield* Effect.tryPromise({
    try: () =>
      env.OBJECTS.list({
        prefix: "processes/",
        cursor: cursor ?? undefined,
        limit: 50,
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
        if (metadata.format === "run-v7") return;
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
        const previous = yield* Effect.gen(function* () {
          if (metadata.format === "run-v6")
            return yield* Schema.decodeUnknownEffect(Schema.fromJsonString(VersionSixStoredRun), {
              onExcessProperty: "error",
            })(text);
          if (metadata.format === "run-v5") {
            const record = yield* Schema.decodeUnknownEffect(
              Schema.fromJsonString(VersionFiveStoredRun),
            )(text);
            return { ...Struct.omit(record, ["stdinMode"]), inputMode: record.stdinMode };
          }
          if (metadata.format === "run-v4") {
            const record = yield* Schema.decodeUnknownEffect(
              Schema.fromJsonString(VersionFourStoredRun),
            )(text);
            return {
              ...Struct.omit(record, ["stdinMode"]),
              inputMode: record.stdinMode,
              checkpoint: null,
              checkpointCount: 0,
            };
          }
          if (metadata.format === "run-v3") {
            const record = yield* Schema.decodeUnknownEffect(
              Schema.fromJsonString(PreviousStoredRun),
            )(text);
            return {
              ...record,
              inputMode: "closed" as const,
              checkpoint: null,
              checkpointCount: 0,
            };
          }
          const record = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(InlineRun))(text);
          const output = yield* Effect.gen(function* () {
            if (record.output === null) return null;
            return yield* archiveOutput(env, sandboxId, record.output, null);
          });
          return {
            ...record,
            output,
            inputMode: "closed" as const,
            checkpoint: null,
            checkpointCount: 0,
          };
        });
        if (metadata.format === "run-v6" && metadata.summary.stdinMode !== previous.inputMode)
          return yield* new StorageFailure({
            cause: "Process input mode does not match its indexed summary",
          });
        const converted = { ...previous, context: null };
        const summary = Struct.omit(converted, [
          "output",
          "authority",
          "deadlineAt",
          "inputMode",
          "checkpoint",
          "checkpointCount",
        ]);
        if (
          !Schema.toEquivalence(PreviousRunSummary)(
            Struct.omit(summary, ["context"]),
            metadata.summary,
          )
        )
          return yield* new StorageFailure({
            cause: "Process body does not match its indexed summary",
          });
        const serialized = yield* Schema.encodeEffect(Schema.fromJsonString(StoredRun))(converted);
        const receipt = yield* Effect.tryPromise({
          try: () =>
            env.OBJECTS.put(object.key, serialized, {
              onlyIf: { etagMatches: stored.etag },
              customMetadata: Schema.encodeSync(StoredRunMetadata)({
                format: "run-v7",
                summary: { ...summary, stdinMode: converted.inputMode },
              }),
            }),
          catch: (cause) => new StorageFailure({ cause }),
        });
        if (receipt === null)
          return yield* new StorageFailure({ cause: "Process changed during output migration" });
        progress.migrated += 1;
        if (converted.status === "queued")
          yield* Effect.tryPromise({
            try: () =>
              env.EVENTS.send(
                Schema.encodeSync(ProcessDelivery)({ key: object.key, eTag: receipt.etag }),
              ),
            catch: (cause) => new QueueFailure({ cause }),
          });
      }),
    { concurrency: 4 },
  );
  if (page.truncated) return { ...progress, cursor: page.cursor };
  return { ...progress, cursor: null };
});
