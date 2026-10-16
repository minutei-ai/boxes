import { Effect, Match, Schema, Struct } from "effect";
import { Id, InputHead, StoredRun, initialTerminalControl } from "./contracts";
import { StorageFailure } from "./storage";
import type { Env } from "./resources";

const GeometryInput = InputHead.mapFields((fields) => ({
  ...Struct.omit(fields, ["attributes", "version"]),
  version: Schema.Literal(2),
}));
const PreviousInput = GeometryInput.mapFields((fields) => ({
  ...Struct.omit(fields, ["terminal", "version"]),
  version: Schema.Literal(1),
}));
const MigrationHead = Schema.Union([PreviousInput, GeometryInput, InputHead]);

export const migrateInput = Effect.fn("migration.inputTerminal")(function* (
  env: Env,
  cursor: string | null,
) {
  const progress = { migrated: 0 };
  const page = yield* Effect.tryPromise({
    try: () =>
      env.OBJECTS.list({ prefix: "process-input/", cursor: cursor ?? undefined, limit: 50 }),
    catch: (cause) => new StorageFailure({ cause }),
  });
  yield* Effect.forEach(
    page.objects,
    (object) =>
      Effect.gen(function* () {
        const parts = object.key.split("/");
        if (parts.length !== 3 || parts[0] !== "process-input" || !parts[2].endsWith(".json"))
          return yield* new StorageFailure({ cause: "Invalid input migration key" });
        const sandboxId = yield* Schema.decodeUnknownEffect(Id)(parts[1]);
        const id = yield* Schema.decodeUnknownEffect(Id)(parts[2].slice(0, -5));
        const stored = yield* Effect.tryPromise({
          try: () => env.OBJECTS.get(object.key, { onlyIf: { etagMatches: object.etag } }),
          catch: (cause) => new StorageFailure({ cause }),
        });
        if (stored === null || !("body" in stored) || stored.size > 131072)
          return yield* new StorageFailure({
            cause: "Input head changed during migration or exceeded its limit",
          });
        const input = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(MigrationHead))(
          yield* Effect.tryPromise({
            try: () => stored.text(),
            catch: (cause) => new StorageFailure({ cause }),
          }),
        );
        if (input.version === 3) return;
        if (input.chunks.reduce((total, chunk) => total + chunk.size, 0) !== input.size)
          return yield* new StorageFailure({
            cause: "Input chunk sizes do not match migration head",
          });
        const process = yield* Effect.tryPromise({
          try: () => env.OBJECTS.get(`processes/${sandboxId}/${id}.json`),
          catch: (cause) => new StorageFailure({ cause }),
        });
        const record = yield* Effect.gen(function* () {
          if (process === null) return null;
          if (process.size > 8388608)
            return yield* new StorageFailure({
              cause: "Oversized process receipt during input migration",
            });
          const record = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(StoredRun))(
            yield* Effect.tryPromise({
              try: () => process.text(),
              catch: (cause) => new StorageFailure({ cause }),
            }),
          );
          if (record.id !== id)
            return yield* new StorageFailure({
              cause: "Process identity does not match input migration key",
            });
          return record;
        });
        const metadata = yield* Effect.sync(() => {
          const geometry = Match.value(input).pipe(
            Match.when({ version: 2 }, (input) => input.terminal),
            Match.orElse(() => {
              if (record !== null && record.stdinMode === "pty")
                return { cols: 80, rows: 24, revision: 0 };
              return null;
            }),
          );
          if (geometry === null) return { terminal: null, attributes: null };
          if (record !== null && (record.status === "queued" || record.status === "running"))
            return { terminal: geometry, attributes: initialTerminalControl };
          return { terminal: geometry, attributes: { ...initialTerminalControl, settled: true } };
        });
        const saved = yield* Effect.tryPromise({
          try: () =>
            env.OBJECTS.put(
              object.key,
              Schema.encodeSync(Schema.fromJsonString(InputHead))({
                ...input,
                version: 3,
                ...metadata,
              }),
              { onlyIf: { etagMatches: stored.etag } },
            ),
          catch: (cause) => new StorageFailure({ cause }),
        });
        if (saved === null)
          return yield* new StorageFailure({
            cause: "Input head changed before migration publication",
          });
        progress.migrated += 1;
      }),
    { concurrency: 4, discard: true },
  );
  if (page.truncated) return { migrated: progress.migrated, cursor: page.cursor };
  return { migrated: progress.migrated, cursor: null };
});
