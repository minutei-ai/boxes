import { Effect, Schema, Semaphore, Struct } from "effect";
import {
  Head,
  Policy,
  EnvironmentMigrationInput,
  EnvironmentMigrationReceipt,
  Program,
  ScriptProgram,
  PythonProgram,
  ShellProgram,
  ExecutionCheckpoint,
  StoredRun,
  StoredRunMetadata,
  Id,
} from "./contracts";
import { archive } from "./code";
import { saveExecutionCheckpoint } from "./checkpoint";
import { StorageFailure } from "./storage";
import type { Env } from "./resources";

const PreviousHead = Head.mapFields((fields) => ({
  ...Struct.omit(fields, ["environment"]),
  version: Schema.Literal(2),
}));
const InitialHead = Schema.Struct({
  manifest: Head.fields.manifest,
  policy: Schema.Struct({
    networkHosts: Policy.fields.networkHosts,
    cpuMs: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 30_000 })),
    maxOutputBytes: Policy.fields.maxOutputBytes,
  }),
  createdAt: Head.fields.createdAt,
  deleted: Head.fields.deleted,
});
const MigratingHead = Schema.Union([Head, PreviousHead, InitialHead]);
const PreviousProgram = Schema.Union([
  ScriptProgram.mapFields((fields) => Struct.omit(fields, ["env"])),
  PythonProgram.mapFields((fields) => Struct.omit(fields, ["env"])),
  ShellProgram.mapFields((fields) => Struct.omit(fields, ["env"])),
]);
const MigratingProgram = Schema.Union([Program, PreviousProgram]);
const MigratingCheckpoint = ExecutionCheckpoint.mapFields((fields) => ({
  ...fields,
  head: Schema.Union([Head, PreviousHead]),
}));
const normalizeHead = (head: typeof MigratingHead.Type): typeof Head.Type => {
  if ("version" in head) {
    if (head.version === 3) return head;
    return { ...head, version: 3, environment: {} };
  }
  return {
    ...head,
    version: 3,
    environment: {},
    policy: {
      networkHosts: head.policy.networkHosts,
      maxOutputBytes: head.policy.maxOutputBytes,
      interruptBudget: 1000,
      memoryBytes: 8388608,
    },
  };
};

export const migrateConfiguration = Effect.fn("migration.configuration")(function* (
  env: Env,
  input: typeof EnvironmentMigrationInput.Type,
) {
  const cursor = input.cursor ?? { phase: "heads", continuation: null };
  const progress = { migrated: 0 };
  const decoding = yield* Semaphore.make(8);
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
    yield* Effect.forEach(
      page.delimitedPrefixes,
      (prefix) =>
        Effect.gen(function* () {
          const key = `${prefix}head.json`;
          const object = yield* Effect.tryPromise({
            try: () => env.OBJECTS.get(key),
            catch: (cause) => new StorageFailure({ cause }),
          });
          if (object === null) return;
          if (object.size > 18_000_000)
            return yield* new StorageFailure({ cause: "Oversized configuration head" });
          yield* Effect.gen(function* () {
            const text = yield* Effect.tryPromise({
              try: () => object.text(),
              catch: (cause) => new StorageFailure({ cause }),
            });
            const previous = yield* Schema.decodeUnknownEffect(
              Schema.fromJsonString(MigratingHead),
              {
                onExcessProperty: "error",
              },
            )(text);
            if ("version" in previous && previous.version === 3) return;
            const current = normalizeHead(previous);
            const written = yield* Effect.tryPromise({
              try: () =>
                env.OBJECTS.put(key, Schema.encodeSync(Schema.fromJsonString(Head))(current), {
                  onlyIf: { etagMatches: object.etag },
                  customMetadata: {
                    ...object.customMetadata,
                    configurationMigrationPriorEtag: object.etag,
                  },
                }),
              catch: (cause) => new StorageFailure({ cause }),
            });
            if (written === null)
              return yield* new StorageFailure({
                cause: "Configuration head changed concurrently",
              });
            progress.migrated += 1;
          }).pipe(
            decoding.withPermits(Math.max(1, Math.min(8, Math.ceil(object.size / 1_048_576)))),
          );
        }),
      { concurrency: 4 },
    );
    if (page.truncated)
      return {
        migrated: progress.migrated,
        cursor: { phase: "heads", continuation: page.cursor },
      } satisfies typeof EnvironmentMigrationReceipt.Type;
    return {
      migrated: progress.migrated,
      cursor: { phase: "processes", continuation: null },
    } satisfies typeof EnvironmentMigrationReceipt.Type;
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
  yield* Effect.forEach(
    page.objects,
    (listed) =>
      Effect.gen(function* () {
        const object = yield* Effect.tryPromise({
          try: () => env.OBJECTS.get(listed.key),
          catch: (cause) => new StorageFailure({ cause }),
        });
        if (object === null || object.size > 16_777_216)
          return yield* new StorageFailure({
            cause: "Missing or oversized process during configuration cutover",
          });
        const record = yield* Effect.gen(function* () {
          const text = yield* Effect.tryPromise({
            try: () => object.text(),
            catch: (cause) => new StorageFailure({ cause }),
          });
          return yield* Schema.decodeUnknownEffect(Schema.fromJsonString(StoredRun))(text);
        }).pipe(decoding.withPermits(Math.max(1, Math.min(8, Math.ceil(object.size / 1_048_576)))));
        const id = yield* Schema.decodeUnknownEffect(Id)(listed.key.split("/")[1]);
        if (listed.key !== `processes/${id}/${record.id}.json`)
          return yield* new StorageFailure({
            cause: "Configuration migration process identity mismatch",
          });
        const key = `sandboxes/${id}/code/${record.sourceHash}`;
        const code = yield* Effect.tryPromise({
          try: () => env.OBJECTS.head(key),
          catch: (cause) => new StorageFailure({ cause }),
        });
        if (code === null || code.size > 18_000_000)
          return yield* new StorageFailure({
            cause: "Missing or oversized archived configuration input",
          });
        const sourceHash = yield* Effect.gen(function* () {
          if (code.customMetadata?.format === "program-json-v2") return record.sourceHash;
          const source = yield* Effect.tryPromise({
            try: () => env.OBJECTS.get(key, { onlyIf: { etagMatches: code.etag } }),
            catch: (cause) => new StorageFailure({ cause }),
          });
          if (source === null || !("body" in source))
            return yield* new StorageFailure({
              cause: "Archived configuration input changed during read",
            });
          const bytes = yield* Effect.tryPromise({
            try: () => source.arrayBuffer(),
            catch: (cause) => new StorageFailure({ cause }),
          });
          const digest = Buffer.from(
            yield* Effect.promise(() => crypto.subtle.digest("SHA-256", bytes)),
          ).toString("hex");
          if (digest !== record.sourceHash)
            return yield* new StorageFailure({
              cause: "Configuration migration program digest mismatch",
            });
          const text = yield* Effect.try({
            try: () => new TextDecoder("utf-8", { fatal: true }).decode(bytes),
            catch: (cause) => new StorageFailure({ cause }),
          });
          const previous = yield* Schema.decodeUnknownEffect(
            Schema.fromJsonString(MigratingProgram),
            { onExcessProperty: "error" },
          )(text).pipe(Effect.result);
          if (previous._tag === "Failure") {
            const historical =
              (code.customMetadata?.format === undefined ||
                code.customMetadata.format === "historical-source-text-v1") &&
              (record.language === "javascript" ||
                record.language === "typescript" ||
                record.language === "python" ||
                record.language === "shell") &&
              (record.status === "exited" ||
                record.status === "failed" ||
                record.status === "cancelled") &&
              record.authority === null &&
              record.deadlineAt === null &&
              record.checkpoint === null;
            if (!historical) return yield* new StorageFailure({ cause: previous.failure });
            yield* Schema.decodeUnknownEffect(Schema.String.check(Schema.isMaxLength(1_048_576)))(
              text,
            ).pipe(Effect.mapError((cause) => new StorageFailure({ cause })));
            if (code.customMetadata?.format === "historical-source-text-v1")
              return record.sourceHash;
            const retained = yield* Effect.tryPromise({
              try: () =>
                env.OBJECTS.put(key, bytes, {
                  onlyIf: { etagMatches: code.etag },
                  customMetadata: { format: "historical-source-text-v1" },
                  httpMetadata: { contentType: "text/plain; charset=utf-8" },
                }),
              catch: (cause) => new StorageFailure({ cause }),
            });
            if (retained === null)
              return yield* new StorageFailure({ cause: "Historical source changed concurrently" });
            return record.sourceHash;
          }
          const program = yield* Effect.sync(() => {
            if ("env" in previous.success) return previous.success;
            return { ...previous.success, env: {} };
          });
          const hash = yield* archive(env, id, program);
          if (hash === record.sourceHash) {
            const rewritten = yield* Effect.tryPromise({
              try: () =>
                env.OBJECTS.put(key, bytes, {
                  onlyIf: { etagMatches: code.etag },
                  customMetadata: { format: "program-json-v2" },
                  httpMetadata: { contentType: "application/json" },
                }),
              catch: (cause) => new StorageFailure({ cause }),
            });
            if (rewritten === null)
              return yield* new StorageFailure({
                cause: "Configuration program changed concurrently",
              });
          }
          return hash;
        }).pipe(decoding.withPermits(Math.max(1, Math.min(8, Math.ceil(code.size / 1_048_576)))));
        const checkpoint = yield* Effect.gen(function* () {
          if (record.checkpoint === null) return null;
          const saved = yield* Effect.tryPromise({
            try: () =>
              env.OBJECTS.get(`sandboxes/${id}/execution-checkpoints/${record.checkpoint}.json`),
            catch: (cause) => new StorageFailure({ cause }),
          });
          if (saved === null || saved.size > 16_777_216)
            return yield* new StorageFailure({
              cause: "Missing or oversized checkpoint in configuration migration",
            });
          const bytes = yield* Effect.tryPromise({
            try: () => saved.arrayBuffer(),
            catch: (cause) => new StorageFailure({ cause }),
          });
          const hash = Buffer.from(
            yield* Effect.promise(() => crypto.subtle.digest("SHA-256", bytes)),
          ).toString("hex");
          if (hash !== record.checkpoint)
            return yield* new StorageFailure({ cause: "Configuration checkpoint digest mismatch" });
          const prior = yield* Schema.decodeUnknownEffect(
            Schema.fromJsonString(MigratingCheckpoint),
          )(Buffer.from(bytes).toString());
          if (prior.head.version === 3) return record.checkpoint;
          const current = yield* Effect.tryPromise({
            try: () => env.OBJECTS.get(`sandboxes/${id}/head.json`),
            catch: (cause) => new StorageFailure({ cause }),
          });
          if (current === null || current.size > 18_000_000)
            return yield* new StorageFailure({
              cause: "Missing configuration root during checkpoint conversion",
            });
          const head = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Head))(
            yield* Effect.tryPromise({
              try: () => current.text(),
              catch: (cause) => new StorageFailure({ cause }),
            }),
          );
          const normalized = normalizeHead(prior.head);
          const etag = yield* Effect.sync(() => {
            if (prior.etag !== current.customMetadata?.configurationMigrationPriorEtag)
              return prior.etag;
            const encode = Schema.encodeSync(Schema.fromJsonString(Head));
            if (encode(normalized) !== encode(head)) return prior.etag;
            return current.etag;
          });
          return yield* saveExecutionCheckpoint(env.OBJECTS, id, {
            ...prior,
            head: normalized,
            etag,
          });
        }).pipe(decoding.withPermits(8));
        if (sourceHash === record.sourceHash && checkpoint === record.checkpoint) return;
        const updated = { ...record, sourceHash, checkpoint };
        const metadata = yield* Schema.decodeUnknownEffect(StoredRunMetadata)(
          object.customMetadata,
        );
        const written = yield* Effect.tryPromise({
          try: () =>
            env.OBJECTS.put(
              listed.key,
              Schema.encodeSync(Schema.fromJsonString(StoredRun))(updated),
              {
                onlyIf: { etagMatches: object.etag },
                customMetadata: Schema.encodeSync(StoredRunMetadata)({
                  ...metadata,
                  summary: { ...metadata.summary, sourceHash },
                }),
              },
            ),
          catch: (cause) => new StorageFailure({ cause }),
        });
        if (written === null)
          return yield* new StorageFailure({
            cause: "Process changed during configuration migration",
          });
        progress.migrated += 1;
        if (updated.status === "queued")
          yield* Effect.tryPromise({
            try: () => env.EVENTS.send({ key: listed.key, eTag: written.etag }),
            catch: (cause) => new StorageFailure({ cause }),
          });
      }),
    { concurrency: 4 },
  );
  if (page.truncated)
    return {
      migrated: progress.migrated,
      cursor: { phase: "processes", continuation: page.cursor },
    } satisfies typeof EnvironmentMigrationReceipt.Type;
  return {
    migrated: progress.migrated,
    cursor: null,
  } satisfies typeof EnvironmentMigrationReceipt.Type;
});
