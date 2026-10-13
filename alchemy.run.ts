import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import { Clock, Config, Effect, Layer, Redacted, Schedule, Schema } from "effect";
import { bucket, executions, worker } from "./src/resources";
import { MigrationReceipt } from "./src/contracts";

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
      const receipts = yield* Effect.forEach(
        [
          "/v1/migrations/execution-policy-v2",
          "/v1/migrations/filesystem-v3",
          "/v1/migrations/wasm-inputs-v1",
          "/v1/migrations/process-receipts-v2",
        ],
        (path) =>
          Effect.gen(function* () {
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
            return yield* Schema.decodeUnknownEffect(Schema.fromJsonString(MigrationReceipt))(text);
          }).pipe(
            Effect.retry({
              times: 10,
              schedule: Schedule.spaced("2 seconds"),
              while: (failure) =>
                failure._tag === "MigrationRequestFailure" && failure.cause === 404,
            }),
          ),
      );
      return { receipts, deployedAt: input.deployedAt };
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
