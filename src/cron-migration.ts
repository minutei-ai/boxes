import { Effect, Schema, Struct } from "effect";
import { StoredCron, StoredCronMetadata } from "./contracts";
import { StorageFailure } from "./storage";
import type { Env } from "./resources";

export const PreviousCron = StoredCron.mapFields((fields) => Struct.omit(fields, ["context"]));
const PreviousMetadata = StoredCronMetadata.mapFields((fields) => ({
  ...fields,
  format: Schema.Literal("cron-v1"),
}));
const MigrationMetadata = Schema.Union([StoredCronMetadata, PreviousMetadata]);

export const migrateCron = Effect.fn("migration.cronContexts")(function* (
  env: Env,
  cursor: string | null,
) {
  const progress = { migrated: 0 };
  const page = yield* Effect.tryPromise({
    try: () =>
      env.OBJECTS.list({
        prefix: "schedules/",
        cursor: cursor ?? undefined,
        limit: 50,
        include: ["customMetadata"],
      }),
    catch: (cause) => new StorageFailure({ cause }),
  });
  yield* Effect.forEach(
    page.objects,
    (entry) =>
      Effect.gen(function* () {
        const metadata = yield* Schema.decodeUnknownEffect(MigrationMetadata)(entry.customMetadata);
        if (metadata.format === "cron-v2") return;
        const object = yield* Effect.tryPromise({
          try: () => env.OBJECTS.get(entry.key, { onlyIf: { etagMatches: entry.etag } }),
          catch: (cause) => new StorageFailure({ cause }),
        });
        if (object === null || !("body" in object) || object.size > 22_400_000)
          return yield* new StorageFailure({ cause: "Schedule changed during context migration" });
        const record = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(PreviousCron), {
          onExcessProperty: "error",
        })(
          yield* Effect.tryPromise({
            try: () => object.text(),
            catch: (cause) => new StorageFailure({ cause }),
          }),
        );
        if (entry.key !== `schedules/${record.authority.sandboxId}/${record.id}.json`)
          return yield* new StorageFailure({ cause: "Schedule migration identity mismatch" });
        if ("contextId" in record.execution && record.execution.contextId !== undefined)
          return yield* new StorageFailure({
            cause: "Legacy schedule contains an unsupported context",
          });
        if (
          !Schema.toEquivalence(StoredCronMetadata.fields.summary)(
            metadata.summary,
            Struct.pick(record, ["state", "nextRun"]),
          )
        )
          return yield* new StorageFailure({ cause: "Schedule migration summary mismatch" });
        const next = { ...record, context: null };
        const saved = yield* Effect.tryPromise({
          try: () =>
            env.OBJECTS.put(entry.key, Schema.encodeSync(Schema.fromJsonString(StoredCron))(next), {
              onlyIf: { etagMatches: object.etag },
              customMetadata: Schema.encodeSync(StoredCronMetadata)({
                format: "cron-v2",
                summary: Struct.pick(next, ["state", "nextRun"]),
              }),
            }),
          catch: (cause) => new StorageFailure({ cause }),
        });
        if (saved === null)
          return yield* new StorageFailure({
            cause: "Schedule changed during migration publication",
          });
        progress.migrated += 1;
      }),
    { concurrency: 4 },
  );
  if (page.truncated) return { migrated: progress.migrated, cursor: page.cursor };
  return { migrated: progress.migrated, cursor: null };
});
