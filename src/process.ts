import { Clock, Effect, Schema, Struct } from "effect";
import { requirePermission } from "./auth";
import {
  Capability,
  Fault,
  RunAction,
  RunMetadata,
  RunRecord,
  ProcessListAction,
  ProcessWaitAction,
} from "./contracts";
import { load } from "./modules";
import { archive } from "./code";
import { execute } from "./execution";
import { open, StorageFailure } from "./storage";
import type { Env } from "./resources";
import { shell } from "./shell";

export const reserve = Effect.fn("process.reserve")(function* (
  env: Env,
  capability: typeof Capability.Type,
  action: typeof RunAction.Type,
) {
  yield* requirePermission(capability, "execute");
  const session = yield* open(env, capability.sandboxId);
  const program = yield* load(env, capability, session.kernel, action);
  const startedAt = yield* Clock.currentTimeMillis;
  const key = `sandboxes/${capability.sandboxId}/runs/${action.id}.json`;
  if (
    program.language === "wasm" &&
    (program.source.length % 4 !== 0 ||
      !/^[A-Za-z0-9+/]*={0,2}$/.test(program.source) ||
      Buffer.from(program.source.slice(-4), "base64").toString("base64") !==
        program.source.slice(-4))
  )
    return yield* new Fault({
      code: "EINVAL",
      status: 400,
      message: "Invalid canonical Wasm base64",
    });
  const sourceHash = yield* archive(env, capability.sandboxId, program);
  const record: typeof RunRecord.Type = {
    id: action.id,
    status: "running",
    sourceHash,
    language: program.language,
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
  return { record, program, etag: receipt.etag };
});

export const complete = Effect.fn("process.complete")(function* (
  env: Env,
  capability: typeof Capability.Type,
  reservation: Effect.Success<ReturnType<typeof reserve>>,
  timeoutMs: number | null,
) {
  const { record, program, etag } = reservation;
  const key = `sandboxes/${capability.sandboxId}/runs/${record.id}.json`;
  const execution = Effect.scoped(
    Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      if (capability.expiresAt <= now)
        return yield* new Fault({
          code: "UNAUTHORIZED",
          status: 401,
          message: "Capability expired",
        });
      if (program.language === "shell")
        return {
          program,
          changed: false,
          outcome: yield* shell(env, capability, program.source).pipe(Effect.result),
        };
      const session = yield* open(env, capability.sandboxId);
      return yield* execute(env, capability, program, session);
    }),
  );
  const output = yield* Effect.gen(function* () {
    if (timeoutMs === null) return yield* execution;
    return yield* execution.pipe(Effect.timeout(timeoutMs));
  }).pipe(Effect.result);
  const snapshot = yield* Effect.gen(function* () {
    if (output._tag === "Success" && output.success.changed) {
      const hash = yield* archive(env, capability.sandboxId, output.success.program);
      return { ...record, sourceHash: hash };
    }
    return record;
  });
  const finishedAt = yield* Clock.currentTimeMillis;
  const finished = yield* Effect.sync(() => {
    if (output._tag === "Success") {
      if (output.success.outcome._tag === "Success")
        return {
          ...snapshot,
          status: "exited" as const,
          finishedAt,
          output: output.success.outcome.success,
        };
      console.error("Cirro guest failed", output.success.outcome.failure);
    } else console.error("Cirro guest failed", output.failure);
    return { ...snapshot, status: "failed" as const, finishedAt, output: null };
  });
  const completed = yield* Effect.tryPromise({
    try: () =>
      env.OBJECTS.put(key, Schema.encodeSync(Schema.fromJsonString(RunRecord))(finished), {
        onlyIf: { etagMatches: etag },
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

export const run = Effect.fn("process.run")(function* (
  env: Env,
  capability: typeof Capability.Type,
  action: typeof RunAction.Type,
) {
  const reservation = yield* Effect.scoped(reserve(env, capability, action));
  return yield* complete(env, capability, reservation, null);
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

export const wait = Effect.fn("process.wait")(function* (
  env: Env,
  capability: typeof Capability.Type,
  action: typeof ProcessWaitAction.Type,
) {
  yield* requirePermission(capability, "read");
  const startedAt = yield* Clock.currentTimeMillis;
  const deadline = Math.min(startedAt + action.timeoutMs, capability.expiresAt);
  const polling = { delay: 100 };
  while (true) {
    const now = yield* Clock.currentTimeMillis;
    if (capability.expiresAt <= now)
      return yield* new Fault({ code: "UNAUTHORIZED", status: 401, message: "Capability expired" });
    const record = yield* Effect.scoped(inspect(env, capability, action.id));
    const observedAt = yield* Clock.currentTimeMillis;
    if (capability.expiresAt <= observedAt)
      return yield* new Fault({ code: "UNAUTHORIZED", status: 401, message: "Capability expired" });
    if (record.status === "exited") return record;
    if (record.status === "failed")
      return yield* new Fault({
        code: "EXECUTION_FAILED",
        status: 500,
        message: "Execution failed without an observed guest exit; inspect process.get",
      });
    if (observedAt >= deadline)
      return yield* new Fault({
        code: "ETIMEDOUT",
        status: 408,
        message:
          "No exit was observed before the wait deadline; the execution may still be running",
      });
    yield* Effect.sleep(Math.min(polling.delay, deadline - observedAt));
    polling.delay = Math.min(polling.delay * 2, 1000);
  }
});
