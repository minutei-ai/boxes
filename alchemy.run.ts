import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import { Clock, Config, Effect, Layer, Redacted, Schedule, Schema } from "effect";
import { FetchHttpClient, HttpBody, HttpClient } from "effect/http";
import { bucket, executions, worker } from "./src/resources";
import {
  MigrationReceipt,
  EnvironmentMigrationInput,
  EnvironmentMigrationReceipt,
  OutputMigrationInput,
  OutputMigrationReceipt,
  InputMigrationInput,
  InputMigrationReceipt,
  ProcessDeadlineMigrationInput,
  ProcessDeadlineMigrationReceipt,
  FilesystemMigrationInput,
  FilesystemMigrationReceipt,
} from "./src/contracts";

const Deployment = Schema.Struct({
  deployedAt: Schema.Int,
  url: Schema.UndefinedOr(Schema.String),
});
class MigrationStatusError extends Schema.TaggedError<MigrationStatusError>()(
  "MigrationStatusError",
  { status: Schema.Int, path: Schema.String },
) {}
const migrate = Alchemy.Action(
  "Migrations",
  Effect.gen(function* () {
    const key = yield* Config.Redacted("CIRRO_API_KEY");
    const http = (yield* HttpClient.HttpClient).pipe(
      HttpClient.retry({
        times: 2,
        schedule: Schedule.spaced("1 second"),
        while: (failure) => failure.reason._tag === "TransportError",
      }),
    );
    return Effect.fn("deployment.migrate")(
      function* (input: typeof Deployment.Type) {
        const url = yield* Schema.decodeUnknownEffect(Schema.String)(input.url);
        const step = Effect.fn("deployment.migrateStep")(
          function* (path: string) {
            yield* Effect.logInfo({ migration: path, phase: "start" });
            const response = yield* http.post(new URL(path, url), {
              headers: { authorization: `Bearer ${Redacted.value(key)}` },
            });
            if (response.status < 200 || response.status >= 300)
              return yield* new MigrationStatusError({ status: response.status, path });
            const text = yield* response.text;
            const receipt = yield* Schema.decodeUnknownEffect(
              Schema.fromJsonString(MigrationReceipt),
            )(text);
            yield* Effect.logInfo({ migration: path, phase: "done", migrated: receipt.migrated });
            return receipt;
          },
          Effect.timeout("120 seconds"),
          Effect.retry({
            times: 10,
            schedule: Schedule.spaced("2 seconds"),
            while: (failure) => failure._tag === "MigrationStatusError" && failure.status === 404,
          }),
        );
        const environmentMigration = Effect.fn("deployment.environmentMigration")(function* (
          initial: typeof EnvironmentMigrationReceipt.Type.cursor,
        ) {
          const progress = { migrated: 0, pages: 0 };
          const cursors = [initial];
          while (cursors.length > 0) {
            const cursor = cursors.shift();
            const page = yield* Effect.gen(function* () {
              const response = yield* http.post(new URL("/v1/migrations/environment-v1", url), {
                headers: { authorization: `Bearer ${Redacted.value(key)}` },
                body: HttpBody.text(
                  Schema.encodeSync(Schema.fromJsonString(EnvironmentMigrationInput))({ cursor }),
                  "application/json",
                ),
              });
              if (response.status < 200 || response.status >= 300)
                return yield* new MigrationStatusError({
                  status: response.status,
                  path: "/v1/migrations/environment-v1",
                });
              const text = yield* response.text;
              return yield* Schema.decodeUnknownEffect(
                Schema.fromJsonString(EnvironmentMigrationReceipt),
              )(text);
            }).pipe(Effect.timeout("120 seconds"));
            progress.pages += 1;
            progress.migrated += page.migrated;
            yield* Effect.logInfo({
              migration: "environment-v1",
              page: progress.pages,
              migrated: page.migrated,
              nextPhase: page.cursor?.phase ?? "done",
              cursor: page.cursor,
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
          const page = yield* Effect.gen(function* () {
            const response = yield* http.post(new URL("/v1/migrations/process-index-v6", url), {
              headers: { authorization: `Bearer ${Redacted.value(key)}` },
              body: HttpBody.text(
                Schema.encodeSync(Schema.fromJsonString(OutputMigrationInput))({ cursor }),
                "application/json",
              ),
            });
            if (response.status < 200 || response.status >= 300)
              return yield* new MigrationStatusError({
                status: response.status,
                path: "/v1/migrations/process-index-v6",
              });
            const text = yield* response.text;
            return yield* Schema.decodeUnknownEffect(Schema.fromJsonString(OutputMigrationReceipt))(
              text,
            );
          }).pipe(Effect.timeout("120 seconds"));
          progress.pages += 1;
          progress.migrated += page.migrated;
          yield* Effect.logInfo({
            migration: "process-index-v6",
            page: progress.pages,
            migrated: page.migrated,
            hasMore: page.cursor !== null,
          });
          if (page.cursor !== null) cursors.push(page.cursor);
        }
        const inputTerminal = { pages: 0, migrated: 0 };
        const inputCursors: (typeof InputMigrationReceipt.Type.cursor)[] = [null];
        while (inputCursors.length > 0) {
          const cursor = inputCursors.shift();
          const page = yield* Effect.gen(function* () {
            const response = yield* http.post(new URL("/v1/migrations/input-terminal-v3", url), {
              headers: { authorization: `Bearer ${Redacted.value(key)}` },
              body: HttpBody.text(
                Schema.encodeSync(Schema.fromJsonString(InputMigrationInput))({ cursor }),
                "application/json",
              ),
            });
            if (response.status < 200 || response.status >= 300)
              return yield* new MigrationStatusError({
                status: response.status,
                path: "/v1/migrations/input-terminal-v3",
              });
            return yield* Schema.decodeUnknownEffect(Schema.fromJsonString(InputMigrationReceipt))(
              yield* response.text,
            );
          }).pipe(Effect.timeout("120 seconds"));
          inputTerminal.pages += 1;
          inputTerminal.migrated += page.migrated;
          yield* Effect.logInfo({
            migration: "input-terminal-v3",
            page: inputTerminal.pages,
            migrated: page.migrated,
            hasMore: page.cursor !== null,
          });
          if (page.cursor !== null) inputCursors.push(page.cursor);
        }
        const configurationPrograms = yield* environmentMigration(configurationHeads.cursor);
        const filesystem = { pages: 0, migrated: 0 };
        const filesystemCursors: (typeof FilesystemMigrationReceipt.Type.cursor)[] = [null];
        while (filesystemCursors.length > 0) {
          const cursor = filesystemCursors.shift();
          const page = yield* Effect.gen(function* () {
            const response = yield* http.post(new URL("/v1/migrations/filesystem-v4", url), {
              headers: { authorization: `Bearer ${Redacted.value(key)}` },
              body: HttpBody.text(
                Schema.encodeSync(Schema.fromJsonString(FilesystemMigrationInput))({ cursor }),
                "application/json",
              ),
            });
            if (response.status < 200 || response.status >= 300)
              return yield* new MigrationStatusError({
                status: response.status,
                path: "/v1/migrations/filesystem-v4",
              });
            const text = yield* response.text;
            return yield* Schema.decodeUnknownEffect(
              Schema.fromJsonString(FilesystemMigrationReceipt),
            )(text);
          }).pipe(Effect.timeout("120 seconds"));
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
        const deadlines = { pages: 0, migrated: 0 };
        const deadlineCursors: (typeof ProcessDeadlineMigrationReceipt.Type.cursor)[] = [null];
        while (deadlineCursors.length > 0) {
          const cursor = deadlineCursors.shift();
          const page = yield* Effect.gen(function* () {
            const response = yield* http.post(new URL("/v1/migrations/process-deadlines-v1", url), {
              headers: { authorization: `Bearer ${Redacted.value(key)}` },
              body: HttpBody.text(
                Schema.encodeSync(Schema.fromJsonString(ProcessDeadlineMigrationInput))({ cursor }),
                "application/json",
              ),
            });
            if (response.status < 200 || response.status >= 300)
              return yield* new MigrationStatusError({
                status: response.status,
                path: "/v1/migrations/process-deadlines-v1",
              });
            const text = yield* response.text;
            return yield* Schema.decodeUnknownEffect(
              Schema.fromJsonString(ProcessDeadlineMigrationReceipt),
            )(text);
          }).pipe(Effect.timeout("120 seconds"));
          deadlines.pages += 1;
          deadlines.migrated += page.migrated;
          yield* Effect.logInfo({
            migration: "process-deadlines-v1",
            page: deadlines.pages,
            migrated: page.migrated,
            hasMore: page.cursor !== null,
          });
          if (page.cursor !== null) deadlineCursors.push(page.cursor);
        }
        return {
          receipts,
          filesystemMigration: filesystem,
          environmentMigration: { heads: configurationHeads, programs: configurationPrograms },
          processIndexMigration: progress,
          inputTerminalMigration: inputTerminal,
          deadlineMigration: deadlines,
          deployedAt: input.deployedAt,
        };
      },
      Effect.provideService(FetchHttpClient.RequestInit, { keepalive: false }),
    );
  }).pipe(Effect.provide(FetchHttpClient.layer)),
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
