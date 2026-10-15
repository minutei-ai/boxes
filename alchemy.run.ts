import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import { Clock, Config, Effect, Layer, Redacted, Schedule, Schema } from "effect";
import { bucket, executions, worker } from "./src/resources";
import {
  MigrationReceipt,
  EnvironmentMigrationInput,
  EnvironmentMigrationReceipt,
  OutputMigrationInput,
  OutputMigrationReceipt,
  FilesystemMigrationInput,
  FilesystemMigrationReceipt,
} from "./src/contracts";

const Deployment = Schema.Struct({
  deployedAt: Schema.Int,
  url: Schema.UndefinedOr(Schema.String),
});
class MigrationRequestFailure extends Schema.TaggedError<MigrationRequestFailure>()(
  "MigrationRequestFailure",
  { cause: Schema.Unknown, path: Schema.String },
) {}
const migrate = Alchemy.Action(
  "Migrations",
  Effect.gen(function* () {
    const key = yield* Config.Redacted("CIRRO_API_KEY");
    return Effect.fn("deployment.migrate")(function* (input: typeof Deployment.Type) {
      const url = yield* Schema.decodeUnknownEffect(Schema.String)(input.url);
      const step = Effect.fn("deployment.migrateStep")(
        function* (path: string) {
          yield* Effect.logInfo({ migration: path, phase: "start" });
          const response = yield* Effect.tryPromise({
            try: () =>
              fetch(new URL(path, url), {
                method: "POST",
                headers: { authorization: `Bearer ${Redacted.value(key)}` },
                signal: AbortSignal.timeout(120_000),
              }),
            catch: (cause) => new MigrationRequestFailure({ cause, path }),
          });
          if (!response.ok)
            return yield* new MigrationRequestFailure({ cause: response.status, path });
          const text = yield* Effect.tryPromise({
            try: () => response.text(),
            catch: (cause) => new MigrationRequestFailure({ cause, path }),
          });
          const receipt = yield* Schema.decodeUnknownEffect(
            Schema.fromJsonString(MigrationReceipt),
          )(text);
          yield* Effect.logInfo({ migration: path, phase: "done", migrated: receipt.migrated });
          return receipt;
        },
        Effect.retry({
          times: 10,
          schedule: Schedule.spaced("2 seconds"),
          while: (failure) => failure._tag === "MigrationRequestFailure" && failure.cause === 404,
        }),
      );
      const environmentMigration = Effect.fn("deployment.environmentMigration")(function* (
        initial: typeof EnvironmentMigrationReceipt.Type.cursor,
      ) {
        const progress = { migrated: 0, pages: 0 };
        const cursors = [initial];
        while (cursors.length > 0) {
          const cursor = cursors.shift();
          const response = yield* Effect.tryPromise({
            try: () =>
              fetch(new URL("/v1/migrations/environment-v1", url), {
                method: "POST",
                headers: {
                  authorization: `Bearer ${Redacted.value(key)}`,
                  "content-type": "application/json",
                },
                body: Schema.encodeSync(Schema.fromJsonString(EnvironmentMigrationInput))({
                  cursor,
                }),
                signal: AbortSignal.timeout(120_000),
              }),
            catch: (cause) =>
              new MigrationRequestFailure({ cause, path: "/v1/migrations/environment-v1" }),
          });
          if (!response.ok)
            return yield* new MigrationRequestFailure({
              cause: response.status,
              path: "/v1/migrations/environment-v1",
            });
          const text = yield* Effect.tryPromise({
            try: () => response.text(),
            catch: (cause) =>
              new MigrationRequestFailure({ cause, path: "/v1/migrations/environment-v1" }),
          });
          const page = yield* Schema.decodeUnknownEffect(
            Schema.fromJsonString(EnvironmentMigrationReceipt),
          )(text);
          progress.pages += 1;
          progress.migrated += page.migrated;
          yield* Effect.logInfo({
            migration: "environment-v1",
            page: progress.pages,
            migrated: page.migrated,
            nextPhase: page.cursor?.phase ?? "done",
          });
          if (cursor === undefined || cursor === null || cursor.phase === "heads") {
            if (page.cursor?.phase === "processes") return { ...progress, cursor: page.cursor };
          }
          if (page.cursor !== null) cursors.push(page.cursor);
        }
        return { ...progress, cursor: null };
      });
      const configurationHeads = yield* environmentMigration(null);
      const receipts = yield* Effect.forEach(
        ["/v1/migrations/wasm-inputs-v1", "/v1/migrations/process-receipts-v2"],
        step,
        { concurrency: 1 },
      );
      const progress = { pages: 0, migrated: 0 };
      const cursors: (string | null)[] = [null];
      while (cursors.length > 0) {
        const cursor = cursors.shift();
        const response = yield* Effect.tryPromise({
          try: () =>
            fetch(new URL("/v1/migrations/output-chunks-v1", url), {
              method: "POST",
              headers: {
                authorization: `Bearer ${Redacted.value(key)}`,
                "content-type": "application/json",
              },
              body: Schema.encodeSync(Schema.fromJsonString(OutputMigrationInput))({ cursor }),
            }),
          catch: (cause) =>
            new MigrationRequestFailure({ cause, path: "/v1/migrations/output-chunks-v1" }),
        });
        if (!response.ok)
          return yield* new MigrationRequestFailure({
            cause: response.status,
            path: "/v1/migrations/output-chunks-v1",
          });
        const text = yield* Effect.tryPromise({
          try: () => response.text(),
          catch: (cause) =>
            new MigrationRequestFailure({ cause, path: "/v1/migrations/output-chunks-v1" }),
        });
        const page = yield* Schema.decodeUnknownEffect(
          Schema.fromJsonString(OutputMigrationReceipt),
        )(text);
        progress.pages += 1;
        progress.migrated += page.migrated;
        yield* Effect.logInfo({
          migration: "process-input-v4",
          page: progress.pages,
          migrated: page.migrated,
          hasMore: page.cursor !== null,
        });
        if (page.cursor !== null) cursors.push(page.cursor);
      }
      const configurationPrograms = yield* environmentMigration(configurationHeads.cursor);
      const filesystem = { pages: 0, migrated: 0 };
      const filesystemCursors: (typeof FilesystemMigrationReceipt.Type.cursor)[] = [null];
      while (filesystemCursors.length > 0) {
        const cursor = filesystemCursors.shift();
        const response = yield* Effect.tryPromise({
          try: () =>
            fetch(new URL("/v1/migrations/filesystem-v4", url), {
              method: "POST",
              headers: {
                authorization: `Bearer ${Redacted.value(key)}`,
                "content-type": "application/json",
              },
              body: Schema.encodeSync(Schema.fromJsonString(FilesystemMigrationInput))({ cursor }),
              signal: AbortSignal.timeout(120_000),
            }),
          catch: (cause) =>
            new MigrationRequestFailure({ cause, path: "/v1/migrations/filesystem-v4" }),
        });
        if (!response.ok)
          return yield* new MigrationRequestFailure({
            cause: response.status,
            path: "/v1/migrations/filesystem-v4",
          });
        const text = yield* Effect.tryPromise({
          try: () => response.text(),
          catch: (cause) =>
            new MigrationRequestFailure({ cause, path: "/v1/migrations/filesystem-v4" }),
        });
        const page = yield* Schema.decodeUnknownEffect(
          Schema.fromJsonString(FilesystemMigrationReceipt),
        )(text);
        filesystem.pages += 1;
        filesystem.migrated += page.migrated;
        yield* Effect.logInfo({
          migration: "filesystem-v4",
          page: filesystem.pages,
          migrated: page.migrated,
          hasMore: page.cursor !== null,
        });
        if (page.cursor !== null) filesystemCursors.push(page.cursor);
      }
      return {
        receipts,
        filesystemMigration: filesystem,
        environmentMigration: { heads: configurationHeads, programs: configurationPrograms },
        inputMigration: progress,
        deployedAt: input.deployedAt,
      };
    });
  }),
);

const state = Layer.unwrap(
  Alchemy.Stage.pipe(
    Effect.map((stage) => {
      if (stage === "dev" || stage.startsWith("dev_")) return Alchemy.localState();
      return Cloudflare.state();
    }),
  ),
);
const Output = Schema.Struct({ url: Schema.String, bucketName: Schema.String });
export class Cirro extends Alchemy.Stack<Cirro, typeof Output.Type>()("cirro") {}
export default Cirro.make(
  { providers: Cloudflare.providers(), state },
  Effect.gen(function* () {
    const service = yield* worker;
    const objects = yield* bucket;
    const queue = yield* executions;
    yield* Cloudflare.Queues.Consumer("ExecutionConsumer", {
      queueId: queue.queueId,
      scriptName: service.workerName,
      settings: {
        batchSize: 1,
        maxConcurrency: 1,
        maxRetries: 100,
        maxWaitTimeMs: 0,
        retryDelay: 30,
      },
    });
    const deployedAt = yield* Clock.currentTimeMillis;
    yield* migrate({ deployedAt, url: service.url });
    return { url: service.url, bucketName: objects.bucketName };
  }),
);
