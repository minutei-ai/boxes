import { Clock, Effect, Schema, Struct } from "effect";
import { requirePermission } from "./auth";
import {
  Capability,
  Fault,
  RunAction,
  StoredRun,
  StoredRunMetadata,
  ProcessDelivery,
  Id,
  RunRecord,
  ProcessListAction,
  ProcessWaitAction,
} from "./contracts";
import { load } from "./modules";
import { archive, restore } from "./code";
import { execute } from "./execution";
import { open, StorageFailure } from "./storage";
import type { Env } from "./resources";
import { shell } from "./shell";

const reserve = Effect.fn("process.reserve")(function* (
  env: Env,
  capability: typeof Capability.Type,
  action: typeof RunAction.Type,
  detached: boolean,
) {
  yield* requirePermission(capability, "execute");
  const session = yield* open(env, capability.sandboxId);
  const program = yield* load(env, capability, session.kernel, action);
  const startedAt = yield* Clock.currentTimeMillis;
  const key = `processes/${capability.sandboxId}/${action.id}.json`;
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
  const launch = yield* Effect.sync(() => {
    if (detached) return { status: "queued" as const, authority: capability };
    return { status: "running" as const, authority: null };
  });
  const record: typeof RunRecord.Type = {
    id: action.id,
    status: launch.status,
    sourceHash,
    language: program.language,
    startedAt,
    finishedAt: null,
    output: null,
  };
  const stored = { ...record, authority: launch.authority, deadlineAt: null };
  const receipt = yield* Effect.tryPromise({
    try: () =>
      env.OBJECTS.put(key, Schema.encodeSync(Schema.fromJsonString(StoredRun))(stored), {
        onlyIf: { etagDoesNotMatch: "*" },
        customMetadata: Schema.encodeSync(StoredRunMetadata)({
          format: "run-v2",
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
  const prepared: ReturnType<typeof restore> = Effect.succeed(program);
  return { record, program: prepared, etag: receipt.etag };
});

const complete = Effect.fn("process.complete")(function* (
  env: Env,
  capability: typeof Capability.Type,
  reservation: Effect.Success<ReturnType<typeof reserve>>,
  timeoutMs: number | null,
) {
  const { record, etag } = reservation;
  const key = `processes/${capability.sandboxId}/${record.id}.json`;
  const execution = Effect.scoped(
    Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      if (capability.expiresAt <= now)
        return yield* new Fault({
          code: "UNAUTHORIZED",
          status: 401,
          message: "Capability expired",
        });
      const program = yield* reservation.program;
      const admittedAt = yield* Clock.currentTimeMillis;
      if (capability.expiresAt <= admittedAt)
        return yield* new Fault({
          code: "UNAUTHORIZED",
          status: 401,
          message: "Capability expired before program entry",
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
      env.OBJECTS.put(
        key,
        Schema.encodeSync(Schema.fromJsonString(StoredRun))({
          ...finished,
          authority: null,
          deadlineAt: null,
        }),
        {
          onlyIf: { etagMatches: etag },
          customMetadata: Schema.encodeSync(StoredRunMetadata)({
            format: "run-v2",
            summary: Struct.omit(finished, ["output"]),
          }),
        },
      ),
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
  const reservation = yield* Effect.scoped(reserve(env, capability, action, false));
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
    try: () => env.OBJECTS.get(`processes/${capability.sandboxId}/${id}.json`),
    catch: (cause) => new StorageFailure({ cause }),
  });
  if (object === null)
    return yield* new Fault({ code: "ENOENT", status: 404, message: "Execution does not exist" });
  const text = yield* Effect.tryPromise({
    try: () => object.text(),
    catch: (cause) => new StorageFailure({ cause }),
  });
  return yield* Schema.decodeUnknownEffect(Schema.fromJsonString(StoredRun))(text).pipe(
    Effect.map((stored) => Struct.omit(stored, ["authority", "deadlineAt"])),
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
        prefix: `processes/${capability.sandboxId}/`,
        limit: action.limit,
        include: ["customMetadata"],
      };
      if (action.cursor === null) return env.OBJECTS.list(options);
      return env.OBJECTS.list({ ...options, cursor: action.cursor });
    },
    catch: (cause) => new StorageFailure({ cause }),
  });
  const items = yield* Effect.forEach(page.objects, (object) =>
    Schema.decodeUnknownEffect(StoredRunMetadata)(object.customMetadata).pipe(
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

export class ExecutionPending extends Schema.TaggedError<ExecutionPending>()("ExecutionPending", {
  retryAfterSeconds: Schema.Int,
}) {}

export const dispatch = Effect.fn("process.dispatch")(function* (env: Env, body: unknown) {
  const event = yield* Schema.decodeUnknownEffect(ProcessDelivery)(body);
  const parts = event.key.split("/");
  if (parts.length !== 3 || parts[0] !== "processes" || !parts[2]?.endsWith(".json")) return;
  const identity = yield* Schema.decodeUnknownEffect(Schema.Struct({ sandboxId: Id, id: Id }))({
    sandboxId: parts[1],
    id: parts[2].slice(0, -5),
  });
  const object = yield* Effect.tryPromise({
    try: () => env.OBJECTS.get(event.key),
    catch: (cause) => new StorageFailure({ cause }),
  });
  if (object === null) return;
  if (object.size > 8_388_608)
    return yield* new StorageFailure({ cause: "Process receipt exceeds its limit" });
  const text = yield* Effect.tryPromise({
    try: () => object.text(),
    catch: (cause) => new StorageFailure({ cause }),
  });
  const stored = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(StoredRun))(text);
  if (stored.id !== identity.id)
    return yield* new StorageFailure({ cause: "Process identity mismatch" });
  const now = yield* Clock.currentTimeMillis;
  if (stored.status === "running" && stored.deadlineAt !== null) {
    if (now < stored.deadlineAt)
      return yield* new ExecutionPending({
        retryAfterSeconds: Math.min(300, Math.max(1, Math.ceil((stored.deadlineAt - now) / 1000))),
      });
    const failed = {
      ...stored,
      status: "failed" as const,
      authority: null,
      deadlineAt: null,
      finishedAt: now,
      output: null,
    };
    yield* Effect.tryPromise({
      try: () =>
        env.OBJECTS.put(event.key, Schema.encodeSync(Schema.fromJsonString(StoredRun))(failed), {
          onlyIf: { etagMatches: object.etag },
          customMetadata: Schema.encodeSync(StoredRunMetadata)({
            format: "run-v2",
            summary: Struct.omit(failed, ["output", "authority", "deadlineAt"]),
          }),
        }),
      catch: (cause) => new StorageFailure({ cause }),
    });
    return;
  }
  if (stored.status !== "queued" || event.eTag !== object.etag) return;
  if (stored.authority === null || stored.authority.sandboxId !== identity.sandboxId)
    return yield* new StorageFailure({ cause: "Queued execution has no matching authority" });
  const capability = stored.authority;
  const running = {
    ...stored,
    status: "running" as const,
    startedAt: now,
    authority: null,
    deadlineAt: now + 900_000,
  };
  const claimed = yield* Effect.tryPromise({
    try: () =>
      env.OBJECTS.put(event.key, Schema.encodeSync(Schema.fromJsonString(StoredRun))(running), {
        onlyIf: { etagMatches: object.etag },
        customMetadata: Schema.encodeSync(StoredRunMetadata)({
          format: "run-v2",
          summary: Struct.omit(running, ["output", "authority", "deadlineAt"]),
        }),
      }),
    catch: (cause) => new StorageFailure({ cause }),
  });
  if (claimed === null) return;
  const record = Struct.omit(running, ["authority", "deadlineAt"]);
  yield* complete(
    env,
    capability,
    { record, etag: claimed.etag, program: restore(env, capability.sandboxId, running.sourceHash) },
    840_000,
  );
});

export class QueueFailure extends Schema.TaggedError<QueueFailure>()("QueueFailure", {
  cause: Schema.Unknown,
}) {}

export const spawn = Effect.fn("process.spawn")(function* (
  env: Env,
  capability: typeof Capability.Type,
  action: typeof RunAction.Type,
) {
  const reservation = yield* Effect.scoped(reserve(env, capability, action, true));
  yield* Effect.tryPromise({
    try: () =>
      env.EVENTS.send(
        Schema.encodeSync(ProcessDelivery)({
          key: `processes/${capability.sandboxId}/${reservation.record.id}.json`,
          eTag: reservation.etag,
        }),
      ),
    catch: (cause) => new QueueFailure({ cause }),
  });
  return reservation.record;
});

export const reconcile = Effect.fn("process.reconcile")(function* (env: Env) {
  const sent = { count: 0 };
  const cursors: (string | undefined)[] = [undefined];
  while (cursors.length > 0) {
    const cursor = cursors.shift();
    const page = yield* Effect.tryPromise({
      try: () =>
        env.OBJECTS.list({
          prefix: "processes/",
          cursor,
          limit: 1000,
          include: ["customMetadata"],
        }),
      catch: (cause) => new StorageFailure({ cause }),
    });
    const pending = yield* Effect.forEach(
      page.objects,
      (object) =>
        Effect.gen(function* () {
          const metadata = yield* Schema.decodeUnknownEffect(StoredRunMetadata)(
            object.customMetadata,
          );
          if (metadata.summary.status !== "queued" && metadata.summary.status !== "running")
            return null;
          const stored = yield* Effect.tryPromise({
            try: () => env.OBJECTS.get(object.key),
            catch: (cause) => new StorageFailure({ cause }),
          });
          if (stored === null) return null;
          if (stored.size > 8_388_608)
            return yield* new StorageFailure({ cause: "Oversized process receipt" });
          const text = yield* Effect.tryPromise({
            try: () => stored.text(),
            catch: (cause) => new StorageFailure({ cause }),
          });
          const record = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(StoredRun))(text);
          const now = yield* Clock.currentTimeMillis;
          if (
            record.status === "queued" ||
            (record.status === "running" && record.deadlineAt !== null && record.deadlineAt <= now)
          )
            return Schema.encodeSync(ProcessDelivery)({ key: object.key, eTag: stored.etag });
          return null;
        }),
      { concurrency: 4 },
    );
    const deliveries = pending.filter((value) => value !== null);
    for (const index of Array.from(
      { length: Math.ceil(deliveries.length / 100) },
      (_, index) => index,
    )) {
      yield* Effect.tryPromise({
        try: () =>
          env.EVENTS.sendBatch(
            deliveries.slice(index * 100, index * 100 + 100).map((body) => ({ body })),
          ),
        catch: (cause) => new QueueFailure({ cause }),
      });
      sent.count += deliveries.slice(index * 100, index * 100 + 100).length;
    }
    if (page.truncated) cursors.push(page.cursor);
  }
  return { notifications: sent.count };
});
