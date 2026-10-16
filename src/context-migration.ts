import { Effect, Option, Schema, Struct } from "effect";
import { ContextMetadata, ContextMigrationInput, Id, StoredContext } from "./contracts";
import { StorageFailure } from "./storage";
import type { Env } from "./resources";

export const PreviousContext = StoredContext.mapFields((fields) =>
  Struct.omit(fields, ["language"]),
);
const MigratingContext = Schema.Union([StoredContext, PreviousContext]);

export const migrateContexts = Effect.fn("migration.contextLanguage")(function* (
  env: Env,
  input: typeof ContextMigrationInput.Type,
) {
  const progress = { migrated: 0 };
  const batch = yield* Effect.gen(function* () {
    if (input.cursor !== null && input.cursor !== undefined && input.cursor.pending.length > 0)
      return input.cursor;
    const page = yield* Effect.tryPromise({
      try: () =>
        env.OBJECTS.list({
          prefix: "sandboxes/",
          delimiter: "/",
          limit: 25,
          cursor: input.cursor?.root ?? undefined,
        }),
      catch: (cause) => new StorageFailure({ cause }),
    });
    const pending = yield* Effect.forEach(page.delimitedPrefixes, (prefix) =>
      Schema.decodeUnknownEffect(Id)(prefix.slice("sandboxes/".length, -1)).pipe(
        Effect.map((sandboxId) => ({ sandboxId, continuation: null })),
      ),
    );
    if (page.truncated) return { root: page.cursor, pending };
    return { root: null, pending };
  });
  const pending = yield* Effect.forEach(
    batch.pending,
    (sandbox) =>
      Effect.gen(function* () {
        const prefix = `sandboxes/${sandbox.sandboxId}/contexts/`;
        const page = yield* Effect.tryPromise({
          try: () =>
            env.OBJECTS.list({
              prefix,
              delimiter: "/",
              limit: 8,
              cursor: sandbox.continuation ?? undefined,
              include: ["customMetadata"],
            }),
          catch: (cause) => new StorageFailure({ cause }),
        });
        yield* Effect.forEach(
          page.objects,
          (entry) =>
            Effect.gen(function* () {
              const metadata = Schema.decodeUnknownOption(ContextMetadata, {
                onExcessProperty: "error",
              })(entry.customMetadata);
              if (Option.isSome(metadata)) {
                if (entry.key !== `${prefix}${metadata.value.summary.id}.json`)
                  return yield* new StorageFailure({
                    cause: "Context migration summary identity mismatch",
                  });
                return;
              }
              const object = yield* Effect.tryPromise({
                try: () => env.OBJECTS.get(entry.key),
                catch: (cause) => new StorageFailure({ cause }),
              });
              if (object === null) return;
              if (object.size > 131072)
                return yield* new StorageFailure({ cause: "Oversized context migration record" });
              const record = yield* Schema.decodeUnknownEffect(
                Schema.fromJsonString(MigratingContext),
                { onExcessProperty: "error" },
              )(
                yield* Effect.tryPromise({
                  try: () => object.text(),
                  catch: (cause) => new StorageFailure({ cause }),
                }),
              );
              if (entry.key !== `${prefix}${record.id}.json`)
                return yield* new StorageFailure({ cause: "Context migration identity mismatch" });
              const next = yield* Effect.sync(() => {
                if ("language" in record) return record;
                return { ...record, language: "javascript" as const };
              });
              const customMetadata = Schema.encodeSync(ContextMetadata)({
                summary: Struct.omit(next, ["heap", "claimId"]),
              });
              if ("language" in record && object.customMetadata?.summary === customMetadata.summary)
                return;
              const saved = yield* Effect.tryPromise({
                try: () =>
                  env.OBJECTS.put(
                    entry.key,
                    Schema.encodeSync(Schema.fromJsonString(StoredContext))(next),
                    { onlyIf: { etagMatches: object.etag }, customMetadata },
                  ),
                catch: (cause) => new StorageFailure({ cause }),
              });
              if (saved === null)
                return yield* new StorageFailure({
                  cause: "Context changed during language migration; retry this page",
                });
              progress.migrated += 1;
            }),
          { concurrency: 1 },
        );
        if (page.truncated) return { sandboxId: sandbox.sandboxId, continuation: page.cursor };
        return null;
      }),
    { concurrency: 4 },
  );
  const remaining = pending.filter((sandbox) => sandbox !== null);
  if (remaining.length > 0 || batch.root !== null)
    return { migrated: progress.migrated, cursor: { root: batch.root, pending: remaining } };
  return { migrated: progress.migrated, cursor: null };
});
