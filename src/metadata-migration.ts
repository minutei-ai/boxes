import { Effect, Schema } from "effect";
import { migrate_metadata } from "../dist/kernel/cirro_kernel";
import { Head } from "./contracts";
import { kernelCall, StorageFailure } from "./storage";
import type { Env } from "./resources";

class MetadataMigrationFailure extends Schema.TaggedError<MetadataMigrationFailure>()(
  "MetadataMigrationFailure",
  { key: Schema.String },
) {}

export const migrateMetadata = Effect.fn("migration.filesystemMetadata")(function* (env: Env) {
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
            return yield* new MetadataMigrationFailure({ key: object.key });
          const text = yield* Effect.tryPromise({
            try: () => stored.text(),
            catch: (cause) => new StorageFailure({ cause }),
          });
          const head = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Head))(text);
          const manifest = yield* kernelCall(() => migrate_metadata(head.manifest));
          if (manifest === head.manifest) return;
          const changed = yield* Effect.tryPromise({
            try: () =>
              env.OBJECTS.put(
                object.key,
                Schema.encodeSync(Schema.fromJsonString(Head))({ ...head, manifest }),
                { onlyIf: { etagMatches: stored.etag } },
              ),
            catch: (cause) => new StorageFailure({ cause }),
          });
          if (changed === null) return yield* new MetadataMigrationFailure({ key: object.key });
          migrated.count += 1;
        }),
    );
    if (page.truncated) cursors.push(page.cursor);
  }
  return { migrated: migrated.count };
});
