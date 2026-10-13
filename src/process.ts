import { Clock, Effect, Schema, Struct } from "effect";
import { requirePermission } from "./auth";
import {
  Capability,
  Fault,
  RunAction,
  RunMetadata,
  RunRecord,
  RunResult,
  ProcessListAction,
} from "./contracts";
import { execute } from "./execution";
import { open, StorageFailure } from "./storage";
import type { Env } from "./resources";
import { shell } from "./shell";

export class ExecutionFailure extends Schema.TaggedError<ExecutionFailure>()("ExecutionFailure", {
  cause: Schema.Unknown,
}) {}
export const run = Effect.fn("process.run")(function* (
  env: Env,
  capability: typeof Capability.Type,
  action: typeof RunAction.Type,
) {
  yield* requirePermission(capability, "execute");
  const session = yield* open(env, capability.sandboxId);
  if (action.language === "python")
    return yield* new Fault({
      code: "UNSUPPORTED_RUNTIME",
      status: 501,
      message: "Python interpreter is not available in the standard Worker",
    });
  const startedAt = yield* Clock.currentTimeMillis;
  const key = `sandboxes/${capability.sandboxId}/runs/${action.id}.json`;
  if (
    action.language === "wasm" &&
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(action.source)
  )
    return yield* new Fault({
      code: "EINVAL",
      status: 400,
      message: "Invalid canonical Wasm base64",
    });
  const source = yield* Effect.sync(() => {
    if (action.language === "wasm") return Buffer.from(action.source, "base64");
    return Buffer.from(action.source, "utf8");
  });
  const digest = yield* Effect.promise(() => crypto.subtle.digest("SHA-256", source));
  const sourceHash = Buffer.from(digest).toString("hex");
  yield* Effect.tryPromise({
    try: () =>
      env.OBJECTS.put(`sandboxes/${capability.sandboxId}/code/${sourceHash}`, source, {
        onlyIf: { etagDoesNotMatch: "*" },
      }),
    catch: (cause) => new StorageFailure({ cause }),
  });
  const record: typeof RunRecord.Type = {
    id: action.id,
    status: "running",
    sourceHash,
    language: action.language,
    startedAt,
    finishedAt: null,
    output: null,
  };
  const receipt = yield* Effect.tryPromise({
    try: () =>
      env.OBJECTS.put(key, Schema.encodeSync(Schema.fromJsonString(RunRecord))(record), {
        onlyIf: { etagDoesNotMatch: "*" },
        customMetadata: Schema.encodeSync(RunMetadata)({
          summary: Struct.omit(record, ["output"]),
        }),
      }),
    catch: (cause) => new StorageFailure({ cause }),
  });
  if (receipt === null)
    return yield* new Fault({
      code: "EEXIST",
      status: 409,
      message: "Execution ID already exists; use process.get to inspect its confirmed state",
    });
  const output = yield* Effect.gen(function* () {
    if (action.language === "shell") return yield* shell(env, capability, action.source);
    return yield* execute(env, capability, action, session.head.policy);
  }).pipe(Effect.result);
  const finishedAt = yield* Clock.currentTimeMillis;
  const finished = yield* Effect.sync(() => {
    if (output._tag === "Success")
      return { ...record, status: "exited" as const, finishedAt, output: output.success };
    console.error("Cirro guest failed", output.failure);
    return { ...record, status: "failed" as const, finishedAt, output: null };
  });
  const completed = yield* Effect.tryPromise({
    try: () =>
      env.OBJECTS.put(key, Schema.encodeSync(Schema.fromJsonString(RunRecord))(finished), {
        onlyIf: { etagMatches: receipt.etag },
        customMetadata: Schema.encodeSync(RunMetadata)({
          summary: Struct.omit(finished, ["output"]),
        }),
      }),
    catch: (cause) => new StorageFailure({ cause }),
  });
  if (completed === null)
    return yield* new Fault({
      code: "CONFLICT",
      status: 409,
      message: "Execution state changed; inspect process.get",
    });
  return finished;
});

export const inspect = Effect.fn("process.inspect")(function* (
  env: Env,
  capability: typeof Capability.Type,
  id: string,
) {
  yield* requirePermission(capability, "read");
  yield* open(env, capability.sandboxId);
  const object = yield* Effect.tryPromise({
    try: () => env.OBJECTS.get(`sandboxes/${capability.sandboxId}/runs/${id}.json`),
    catch: (cause) => new StorageFailure({ cause }),
  });
  if (object === null)
    return yield* new Fault({ code: "ENOENT", status: 404, message: "Execution does not exist" });
  const text = yield* Effect.tryPromise({
    try: () => object.text(),
    catch: (cause) => new StorageFailure({ cause }),
  });
  return yield* Schema.decodeUnknownEffect(Schema.fromJsonString(RunRecord))(text).pipe(
    Effect.mapError((cause) => new StorageFailure({ cause })),
  );
});

export const list = Effect.fn("process.list")(function* (
  env: Env,
  capability: typeof Capability.Type,
  action: typeof ProcessListAction.Type,
) {
  yield* requirePermission(capability, "read");
  yield* open(env, capability.sandboxId);
  const page = yield* Effect.tryPromise({
    try: () => {
      const options: R2ListOptions = {
        prefix: `sandboxes/${capability.sandboxId}/runs/`,
        limit: action.limit,
        include: ["customMetadata"],
      };
      if (action.cursor === null) return env.OBJECTS.list(options);
      return env.OBJECTS.list({ ...options, cursor: action.cursor });
    },
    catch: (cause) => new StorageFailure({ cause }),
  });
  const items = yield* Effect.forEach(page.objects, (object) =>
    Schema.decodeUnknownEffect(RunMetadata)(object.customMetadata).pipe(
      Effect.map((metadata) => metadata.summary),
    ),
  );
  if (page.truncated) return { items, cursor: page.cursor };
  return { items, cursor: null };
});
