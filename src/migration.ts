import { Effect, Schema } from "effect";
import { Head } from "./contracts";
import type { Env } from "./resources";
import { StorageFailure } from "./storage";

const PriorHead = Schema.Struct({
  manifest: Head.fields.manifest,
  policy: Schema.Struct({
    networkHosts: Head.fields.policy.fields.networkHosts,
    cpuMs: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 30_000 })),
    maxOutputBytes: Head.fields.policy.fields.maxOutputBytes,
  }),
  createdAt: Head.fields.createdAt,
  deleted: Head.fields.deleted,
});
class MigrationFailure extends Schema.TaggedError<MigrationFailure>()("MigrationFailure", {
  key: Schema.String,
}) {}

export const migrate = Effect.fn("migration.executionPolicy")(function* (env: Env) {
  const cursors: (string | undefined)[] = [undefined];
  const migrated = { count: 0 };
  while (cursors.length > 0) {
    const cursor = cursors.shift();
    const page = yield* Effect.tryPromise({
      try: () => {
        if (cursor === undefined) return env.OBJECTS.list({ prefix: "sandboxes/", limit: 100 });
        return env.OBJECTS.list({ prefix: "sandboxes/", cursor, limit: 100 });
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
          if (stored === null) return yield* new MigrationFailure({ key: object.key });
          if (stored.size > 18_000_000) return yield* new MigrationFailure({ key: object.key });
          const text = yield* Effect.tryPromise({
            try: () => stored.text(),
            catch: (cause) => new StorageFailure({ cause }),
          });
          const decoded = yield* Schema.decodeUnknownEffect(
            Schema.fromJsonString(Schema.Union([Head, PriorHead])),
            { onExcessProperty: "error" },
          )(text);
          if ("version" in decoded) return;
          const head: typeof Head.Type = {
            version: 2,
            manifest: decoded.manifest,
            createdAt: decoded.createdAt,
            deleted: decoded.deleted,
            policy: {
              networkHosts: decoded.policy.networkHosts,
              maxOutputBytes: decoded.policy.maxOutputBytes,
              interruptBudget: 1000,
              memoryBytes: 8_388_608,
            },
          };
          const written = yield* Effect.tryPromise({
            try: () =>
              env.OBJECTS.put(object.key, Schema.encodeSync(Schema.fromJsonString(Head))(head), {
                onlyIf: { etagMatches: stored.etag },
              }),
            catch: (cause) => new StorageFailure({ cause }),
          });
          if (written === null) return yield* new MigrationFailure({ key: object.key });
          migrated.count += 1;
        }),
    );
    if (page.truncated) cursors.push(page.cursor);
  }
  return { migrated: migrated.count };
});
