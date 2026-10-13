import { Effect, Schema, Struct } from "effect";
import { RunRecord, StoredRun, StoredRunMetadata, Id } from "./contracts";
import { StorageFailure } from "./storage";
import type { Env } from "./resources";

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
          const encoded = Schema.encodeSync(Schema.fromJsonString(StoredRun))({
            ...record,
            authority: null,
            deadlineAt: null,
          });
          const fenced = yield* Effect.tryPromise({
            try: () =>
              env.OBJECTS.put(object.key, encoded, { onlyIf: { etagMatches: stored.etag } }),
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
                  format: "run-v2",
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
