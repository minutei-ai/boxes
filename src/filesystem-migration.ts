import { Effect, Schema } from "effect";
import { migrate_filesystem } from "../dist/kernel/cirro_kernel";
import {
  Head,
  ExecutionCheckpoint,
  Id,
  StoredRun,
  StoredRunMetadata,
  FilesystemMigrationInput,
  FilesystemMigrationReceipt,
} from "./contracts";
import { kernelCall, StorageFailure } from "./storage";
import type { Env } from "./resources";

const MigratingCheckpoint = ExecutionCheckpoint.mapFields((fields) => ({
  ...fields,
  version: Schema.Union([Schema.Literal(1), fields.version]),
}));

class FilesystemMigrationFailure extends Schema.TaggedError<FilesystemMigrationFailure>()(
  "FilesystemMigrationFailure",
  { key: Schema.String },
) {}

export const migrateFilesystem = Effect.fn("migration.filesystem")(function* (
  env: Env,
  input: typeof FilesystemMigrationInput.Type,
) {
  const cursor = input.cursor ?? { phase: "heads", continuation: null };
  const migrated = { count: 0 };
  if (cursor.phase === "heads") {
    const page = yield* Effect.tryPromise({
      try: () =>
        env.OBJECTS.list({
          prefix: "sandboxes/",
          delimiter: "/",
          limit: 25,
          cursor: cursor.continuation ?? undefined,
        }),
      catch: (cause) => new StorageFailure({ cause }),
    });
    yield* Effect.forEach(page.delimitedPrefixes, (prefix) =>
      Effect.gen(function* () {
        const key = `${prefix}head.json`;
        const stored = yield* Effect.tryPromise({
          try: () => env.OBJECTS.get(key),
          catch: (cause) => new StorageFailure({ cause }),
        });
        if (stored === null) return;
        if (stored.size > 18_000_000) return yield* new FilesystemMigrationFailure({ key });
        const text = yield* Effect.tryPromise({
          try: () => stored.text(),
          catch: (cause) => new StorageFailure({ cause }),
        });
        const head = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Head))(text);
        const manifest = yield* kernelCall(() => migrate_filesystem(head.manifest));
        if (manifest === head.manifest) return;
        const changed = yield* Effect.tryPromise({
          try: () =>
            env.OBJECTS.put(
              key,
              Schema.encodeSync(Schema.fromJsonString(Head))({ ...head, manifest }),
              {
                onlyIf: { etagMatches: stored.etag },
                customMetadata: { filesystemMigrationPriorEtag: stored.etag },
              },
            ),
          catch: (cause) => new StorageFailure({ cause }),
        });
        if (changed === null) return yield* new FilesystemMigrationFailure({ key });
        migrated.count += 1;
      }),
    );
    if (page.truncated)
      return {
        migrated: migrated.count,
        cursor: { phase: "heads", continuation: page.cursor },
      } satisfies typeof FilesystemMigrationReceipt.Type;
    return {
      migrated: migrated.count,
      cursor: { phase: "checkpoints", continuation: null },
    } satisfies typeof FilesystemMigrationReceipt.Type;
  }
  const page = yield* Effect.tryPromise({
    try: () =>
      env.OBJECTS.list({
        prefix: "processes/",
        limit: 25,
        cursor: cursor.continuation ?? undefined,
      }),
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
      const id = yield* Schema.decodeUnknownEffect(Id)(object.key.split("/")[1]);
      if (object.key !== `processes/${id}/${record.id}.json`)
        return yield* new FilesystemMigrationFailure({ key: object.key });
      const stored = yield* Effect.tryPromise({
        try: () => env.OBJECTS.get(`sandboxes/${id}/head.json`),
        catch: (cause) => new StorageFailure({ cause }),
      });
      if (stored === null || stored.size > 18_000_000)
        return yield* new FilesystemMigrationFailure({ key: object.key });
      const head = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Head))(
        yield* Effect.tryPromise({
          try: () => stored.text(),
          catch: (cause) => new StorageFailure({ cause }),
        }),
      );
      const manifest = yield* kernelCall(() => migrate_filesystem(head.manifest));
      if (manifest !== head.manifest)
        return yield* new FilesystemMigrationFailure({ key: object.key });
      const checkpointObject = yield* Effect.tryPromise({
        try: () =>
          env.OBJECTS.get(`sandboxes/${id}/execution-checkpoints/${record.checkpoint}.json`),
        catch: (cause) => new StorageFailure({ cause }),
      });
      if (checkpointObject === null || checkpointObject.size > 16_777_216)
        return yield* new FilesystemMigrationFailure({ key: object.key });
      const checkpointBytes = yield* Effect.tryPromise({
        try: () => checkpointObject.arrayBuffer(),
        catch: (cause) => new StorageFailure({ cause }),
      });
      const checkpointHash = Buffer.from(
        yield* Effect.promise(() => crypto.subtle.digest("SHA-256", checkpointBytes)),
      ).toString("hex");
      if (checkpointHash !== record.checkpoint)
        return yield* new FilesystemMigrationFailure({ key: object.key });
      const checkpoint = yield* Schema.decodeUnknownEffect(
        Schema.fromJsonString(MigratingCheckpoint),
      )(Buffer.from(checkpointBytes).toString());
      const checkpointHeadManifest = yield* kernelCall(() =>
        migrate_filesystem(checkpoint.head.manifest),
      );
      const checkpointManifest = yield* kernelCall(() => migrate_filesystem(checkpoint.manifest));
      const publishedManifest = yield* kernelCall(() =>
        migrate_filesystem(checkpoint.checkpointManifest),
      );
      const checkpointHead = { ...checkpoint.head, manifest: checkpointHeadManifest };
      const etag = yield* Effect.sync(() => {
        if (checkpoint.etag !== stored.customMetadata?.filesystemMigrationPriorEtag)
          return checkpoint.etag;
        if (
          Schema.encodeSync(Schema.fromJsonString(Head))(checkpointHead) !==
          Schema.encodeSync(Schema.fromJsonString(Head))(head)
        )
          return checkpoint.etag;
        return stored.etag;
      });
      if (
        checkpointHeadManifest === checkpoint.head.manifest &&
        checkpointManifest === checkpoint.manifest &&
        publishedManifest === checkpoint.checkpointManifest &&
        etag === checkpoint.etag
      )
        return;
      const encoded = new TextEncoder().encode(
        Schema.encodeSync(Schema.fromJsonString(MigratingCheckpoint))({
          ...checkpoint,
          manifest: checkpointManifest,
          head: checkpointHead,
          etag,
          checkpointManifest: publishedManifest,
        }),
      );
      if (encoded.length > 16_777_216)
        return yield* new FilesystemMigrationFailure({ key: object.key });
      const reference = Buffer.from(
        yield* Effect.promise(() => crypto.subtle.digest("SHA-256", encoded)),
      ).toString("hex");
      yield* Effect.tryPromise({
        try: () =>
          env.OBJECTS.put(`sandboxes/${id}/execution-checkpoints/${reference}.json`, encoded, {
            onlyIf: { etagDoesNotMatch: "*" },
          }),
        catch: (cause) => new StorageFailure({ cause }),
      });
      const metadata = yield* Schema.decodeUnknownEffect(StoredRunMetadata)(process.customMetadata);
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
      if (changed === null) return yield* new FilesystemMigrationFailure({ key: object.key });
      migrated.count += 1;
    }),
  );
  if (page.truncated)
    return {
      migrated: migrated.count,
      cursor: { phase: "checkpoints", continuation: page.cursor },
    } satisfies typeof FilesystemMigrationReceipt.Type;
  return {
    migrated: migrated.count,
    cursor: null,
  } satisfies typeof FilesystemMigrationReceipt.Type;
});
