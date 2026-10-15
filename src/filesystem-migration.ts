import { Effect, Schema } from "effect";
import { migrate_filesystem } from "../dist/kernel/cirro_kernel";
import { Head, Id, StoredRun, StoredRunMetadata } from "./contracts";
import { restoreExecutionCheckpoint, saveExecutionCheckpoint } from "./checkpoint";
import { kernelCall, StorageFailure } from "./storage";
import type { Env } from "./resources";

class FilesystemMigrationFailure extends Schema.TaggedError<FilesystemMigrationFailure>()(
  "FilesystemMigrationFailure",
  { key: Schema.String },
) {}

export const migrateFilesystem = Effect.fn("migration.filesystem")(function* (env: Env) {
  const cursors: (string | undefined)[] = [undefined];
  const migrated = { count: 0 };
  while (cursors.length > 0) {
    const cursor = cursors.shift();
    const page = yield* Effect.tryPromise({
      try: () => {
        if (cursor === undefined) return env.OBJECTS.list({ prefix: "sandboxes/", limit: 100 });
        return env.OBJECTS.list({ prefix: "sandboxes/", limit: 100, cursor });
      },
      catch: (cause) => new StorageFailure({ cause }),
    });
    yield* Effect.forEach(
      page.objects.filter((object) => object.key.endsWith("/head.json")),
      (object) =>
        Effect.gen(function* () {
          const stored = yield* Effect.tryPromise({
            try: () => env.OBJECTS.get(object.key),
            catch: (cause) => new StorageFailure({ cause }),
          });
          if (stored === null || stored.size > 18_000_000)
            return yield* new FilesystemMigrationFailure({ key: object.key });
          const text = yield* Effect.tryPromise({
            try: () => stored.text(),
            catch: (cause) => new StorageFailure({ cause }),
          });
          const head = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Head))(text);
          const manifest = yield* kernelCall(() => migrate_filesystem(head.manifest));
          const current = yield* Effect.gen(function* () {
            if (manifest === head.manifest) return stored;
            const changed = yield* Effect.tryPromise({
              try: () =>
                env.OBJECTS.put(
                  object.key,
                  Schema.encodeSync(Schema.fromJsonString(Head))({ ...head, manifest }),
                  {
                    onlyIf: { etagMatches: stored.etag },
                    customMetadata: { filesystemMigrationPriorEtag: stored.etag },
                  },
                ),
              catch: (cause) => new StorageFailure({ cause }),
            });
            if (changed === null) return yield* new FilesystemMigrationFailure({ key: object.key });
            migrated.count += 1;
            return changed;
          });
          const id = yield* Schema.decodeUnknownEffect(Id)(object.key.split("/")[1]);
          const processCursors: (string | undefined)[] = [undefined];
          while (processCursors.length > 0) {
            const cursor = processCursors.shift();
            const page = yield* Effect.tryPromise({
              try: () => env.OBJECTS.list({ prefix: `processes/${id}/`, limit: 100, cursor }),
              catch: (cause) => new StorageFailure({ cause }),
            });
            yield* Effect.forEach(page.objects, (object) =>
              Effect.gen(function* () {
                const process = yield* Effect.tryPromise({
                  try: () => env.OBJECTS.get(object.key),
                  catch: (cause) => new StorageFailure({ cause }),
                });
                if (process === null || process.size > 16_777_216)
                  return yield* new FilesystemMigrationFailure({ key: object.key });
                const record = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(StoredRun))(
                  yield* Effect.tryPromise({
                    try: () => process.text(),
                    catch: (cause) => new StorageFailure({ cause }),
                  }),
                );
                if (record.checkpoint === null) return;
                const checkpoint = yield* restoreExecutionCheckpoint(
                  env.OBJECTS,
                  id,
                  record.checkpoint,
                );
                const checkpointHeadManifest = yield* kernelCall(() =>
                  migrate_filesystem(checkpoint.head.manifest),
                );
                const checkpointManifest = yield* kernelCall(() =>
                  migrate_filesystem(checkpoint.manifest),
                );
                const publishedManifest = yield* kernelCall(() =>
                  migrate_filesystem(checkpoint.checkpointManifest),
                );
                const checkpointHead = { ...checkpoint.head, manifest: checkpointHeadManifest };
                const etag = yield* Effect.sync(() => {
                  if (checkpoint.etag !== current.customMetadata?.filesystemMigrationPriorEtag)
                    return checkpoint.etag;
                  if (
                    Schema.encodeSync(Schema.fromJsonString(Head))(checkpointHead) !==
                    Schema.encodeSync(Schema.fromJsonString(Head))({ ...head, manifest })
                  )
                    return checkpoint.etag;
                  return current.etag;
                });
                if (
                  checkpointHeadManifest === checkpoint.head.manifest &&
                  checkpointManifest === checkpoint.manifest &&
                  publishedManifest === checkpoint.checkpointManifest &&
                  etag === checkpoint.etag
                )
                  return;
                const reference = yield* saveExecutionCheckpoint(env.OBJECTS, id, {
                  ...checkpoint,
                  manifest: checkpointManifest,
                  head: checkpointHead,
                  etag,
                  checkpointManifest: publishedManifest,
                });
                const metadata = yield* Schema.decodeUnknownEffect(StoredRunMetadata)(
                  process.customMetadata,
                );
                const changed = yield* Effect.tryPromise({
                  try: () =>
                    env.OBJECTS.put(
                      object.key,
                      Schema.encodeSync(Schema.fromJsonString(StoredRun))({
                        ...record,
                        checkpoint: reference,
                      }),
                      {
                        onlyIf: { etagMatches: process.etag },
                        customMetadata: Schema.encodeSync(StoredRunMetadata)(metadata),
                      },
                    ),
                  catch: (cause) => new StorageFailure({ cause }),
                });
                if (changed === null)
                  return yield* new FilesystemMigrationFailure({ key: object.key });
              }),
            );
            if (page.truncated) processCursors.push(page.cursor);
          }
        }),
    );
    if (page.truncated) cursors.push(page.cursor);
  }
  return { migrated: migrated.count };
});
