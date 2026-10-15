import { Clock, Effect, Schema, Struct } from "effect";
import { requirePermission } from "./auth";
import {
  Capability,
  Policy,
  Environment,
  Fault,
  RunAction,
  StoredRun,
  StoredRunMetadata,
  ProcessDelivery,
  Id,
  RunRecord,
  ProcessListAction,
  ProcessWaitAction,
  ProcessOutputAction,
  ProcessOutputPage,
  CapturedStdio,
  CapturedBytes,
  ObservedOutput,
  StoredOutput,
  ProcessLiveOutputAction,
  LiveOutputPage,
  ProcessCancelAction,
  ProcessRecoveryAction,
} from "./contracts";
import { load } from "./modules";
import { archive, restore } from "./code";
import { initializeInput, finishInput } from "./input";
import { execute } from "./execution";
import { head, open, kernelCall, observeDisposal, StorageFailure } from "./storage";
import type { Env } from "./resources";
import type { HostBridge } from "./host";
import { shell } from "./shell";
import { restoreExecutionCheckpoint } from "./checkpoint";
import { archiveOutput, restoreOutput, readOutputRange } from "./output";

export const executionWindowMs = 900_000;

const reserve = Effect.fn("process.reserve")(function* (
  env: Env,
  capability: typeof Capability.Type,
  action: typeof RunAction.Type,
  detached: boolean,
  stdinMode: typeof StoredRun.Type.stdinMode,
  timeoutMs: number | null,
) {
  yield* requirePermission(capability, "execute");
  const session = yield* open(env, capability.sandboxId);
  const defaults = yield* kernelCall(() => session.kernel.package_environment()).pipe(
    Effect.flatMap(
      Schema.decodeUnknownEffect(
        Schema.fromJsonString(Schema.Record(Environment.key, Environment.value)),
      ),
    ),
  );
  const environment = { ...defaults, ...session.head.environment, ...(action.env ?? {}) };
  const program = yield* load(env, capability, session.kernel, action, environment);
  if (stdinMode === "pipe" && program.language !== "wasm")
    return yield* new Fault({
      code: "UNSUPPORTED_RUNTIME",
      status: 501,
      message: "Interactive stdin currently requires a WASI process",
    });
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
    if (detached) return { status: "queued" as const, authority: capability, deadlineAt: null };
    return {
      status: "running" as const,
      authority: null,
      deadlineAt: startedAt + Math.min(executionWindowMs, timeoutMs ?? executionWindowMs),
    };
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
  const stored = {
    ...record,
    output: null,
    authority: launch.authority,
    deadlineAt: launch.deadlineAt,
    stdinMode,
    checkpoint: null,
    checkpointCount: 0,
  };
  const receipt = yield* Effect.tryPromise({
    try: () =>
      env.OBJECTS.put(key, Schema.encodeSync(Schema.fromJsonString(StoredRun))(stored), {
        onlyIf: { etagDoesNotMatch: "*" },
        customMetadata: Schema.encodeSync(StoredRunMetadata)({
          format: "run-v5",
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
  if (stdinMode === "pipe" && program.language === "wasm")
    yield* initializeInput(
      env,
      capability.sandboxId,
      record.id,
      Buffer.from(program.stdin, "base64"),
    );
  const prepared: ReturnType<typeof restore> = Effect.succeed(program);
  return {
    record,
    stdinMode,
    checkpointCount: 0,
    checkpoint: Schema.decodeUnknownSync(StoredRun.fields.checkpoint)(null),
    retainedOutput: Schema.decodeUnknownSync(StoredRun.fields.output)(null),
    program: prepared,
    etag: receipt.etag,
    sandboxEtag: session.etag,
    deadlineAt: launch.deadlineAt,
    allowCheckpoint: detached,
  };
});

const complete = Effect.fn("process.complete")(function* (
  env: Env,
  capability: typeof Capability.Type,
  reservation: Effect.Success<ReturnType<typeof reserve>>,
  timeoutMs: number | null,
  host: HostBridge | null = null,
  memoryLimitBytes: typeof Policy.Type.memoryBytes | null = null,
) {
  const { record, etag } = reservation;
  const key = `processes/${capability.sandboxId}/${record.id}.json`;
  const publication = { etag, cancelled: false };
  const lifetime = { etag: reservation.sandboxEtag };
  const snapshots: (typeof ObservedOutput.Type)[] = [];
  const retained: (typeof StoredOutput.Type)[] = [];
  const captured: (typeof CapturedBytes.Type)[] = [];
  if (record.output !== null) snapshots.push(record.output);
  if (reservation.retainedOutput !== null) retained.push(reservation.retainedOutput);
  const observeCancellation = Effect.fn("process.observeCancellation")(function* () {
    const current = yield* Effect.tryPromise({
      try: () => env.OBJECTS.head(key),
      catch: (cause) => new StorageFailure({ cause }),
    });
    if (current === null)
      return yield* new StorageFailure({ cause: "Execution disappeared while active" });
    const metadata = yield* Schema.decodeUnknownEffect(StoredRunMetadata)(current.customMetadata);
    if (metadata.summary.status === "cancelling")
      return yield* new Fault({
        code: "ECANCELED",
        status: 409,
        message: "Execution cancellation observed",
      });
    if (metadata.summary.status !== "running")
      return yield* new Fault({
        code: "CONFLICT",
        status: 409,
        message: "Execution state changed while active",
      });
  });
  const capture = Effect.fn("process.capture")(function* (
    stdio: typeof CapturedStdio.Type,
    observe?: boolean,
  ) {
    if (observe === true) yield* observeCancellation();
    const bytes = yield* Effect.sync(() => {
      if (typeof stdio.stdout === "string" && typeof stdio.stderr === "string")
        return {
          stdout: Buffer.from(stdio.stdout, "utf8"),
          stderr: Buffer.from(stdio.stderr, "utf8"),
        };
      return {
        stdout: Buffer.from(stdio.stdout),
        stderr: Buffer.from(stdio.stderr),
      };
    });
    const previous = captured[0];
    if (
      previous !== undefined &&
      (bytes.stdout.length < previous.stdout.length ||
        bytes.stderr.length < previous.stderr.length ||
        !bytes.stdout.subarray(0, previous.stdout.length).equals(previous.stdout) ||
        !bytes.stderr.subarray(0, previous.stderr.length).equals(previous.stderr))
    )
      return yield* new Fault({
        code: "EINVAL",
        status: 400,
        message: "Captured standard output was rewound",
      });
    if (
      previous !== undefined &&
      bytes.stdout.equals(previous.stdout) &&
      bytes.stderr.equals(previous.stderr)
    )
      return;
    if (previous === undefined && bytes.stdout.length === 0 && bytes.stderr.length === 0) return;
    const pending = {
      stdout: bytes.stdout.toString("utf8"),
      stderr: bytes.stderr.toString("utf8"),
      exitCode: null,
      result: null,
    };
    const archived = yield* archiveOutput(
      env,
      capability.sandboxId,
      pending,
      retained[0] ?? null,
      bytes,
    );
    const stored = {
      ...record,
      authority: null,
      deadlineAt: reservation.deadlineAt,
      stdinMode: reservation.stdinMode,
      checkpoint: null,
      checkpointCount: reservation.checkpointCount,
      output: archived,
    };
    const written = yield* Effect.tryPromise({
      try: () =>
        env.OBJECTS.put(key, Schema.encodeSync(Schema.fromJsonString(StoredRun))(stored), {
          onlyIf: { etagMatches: publication.etag },
          customMetadata: Schema.encodeSync(StoredRunMetadata)({
            format: "run-v5",
            summary: Struct.omit(record, ["output"]),
          }),
        }),
      catch: (cause) => new StorageFailure({ cause }),
    });
    if (written === null) {
      const current = yield* Effect.tryPromise({
        try: () => env.OBJECTS.head(key),
        catch: (cause) => new StorageFailure({ cause }),
      });
      if (current !== null) {
        const metadata = yield* Schema.decodeUnknownEffect(StoredRunMetadata)(
          current.customMetadata,
        ).pipe(Effect.mapError((cause) => new StorageFailure({ cause })));
        if (metadata.summary.status === "cancelling")
          return yield* new Fault({
            code: "ECANCELED",
            status: 409,
            message: "Execution cancellation requested",
          });
      }
      return yield* new Fault({
        code: "CONFLICT",
        status: 409,
        message: "Execution changed during output publication",
      });
    }
    publication.etag = written.etag;
    snapshots.splice(0, snapshots.length, pending);
    captured.splice(0, captured.length, bytes);
    retained.splice(0, retained.length, archived);
  });
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
      if (reservation.deadlineAt !== null && reservation.deadlineAt <= admittedAt)
        return yield* new Fault({
          code: "ETIMEDOUT",
          status: 408,
          message: "Execution deadline elapsed before program entry",
        });
      if (program.language === "shell" && memoryLimitBytes !== null)
        return yield* new Fault({
          code: "EINVAL",
          status: 400,
          message: "Per-execution memory limits require a JavaScript or TypeScript program",
        });
      if (program.language === "shell")
        return {
          program,
          changed: false,
          outcome: yield* shell(env, capability, program.source, program.env, capture).pipe(
            Effect.result,
          ),
        };
      const session = yield* open(env, capability.sandboxId);
      return yield* execute(
        env,
        capability,
        program,
        session,
        capture,
        yield* Effect.sync(() => {
          if (reservation.stdinMode === "pipe") return record.id;
          return null;
        }),
        reservation.checkpoint,
        reservation.allowCheckpoint,
        host,
        memoryLimitBytes,
      );
    }),
  );
  const cancellation = Effect.gen(function* () {
    while (true) {
      lifetime.etag = yield* observeDisposal(env, capability.sandboxId, lifetime.etag);
      yield* observeCancellation();
      yield* Effect.sleep(1000);
    }
  });
  const supervised = Effect.raceFirst(
    execution.pipe(Effect.tap(() => observeDisposal(env, capability.sandboxId, lifetime.etag))),
    cancellation,
  );
  const output = yield* Effect.gen(function* () {
    if (reservation.deadlineAt === null) {
      if (timeoutMs === null) return yield* supervised;
      return yield* supervised.pipe(Effect.timeout(timeoutMs));
    }
    const remaining = Math.max(1, reservation.deadlineAt - (yield* Clock.currentTimeMillis));
    if (timeoutMs === null) return yield* supervised.pipe(Effect.timeout(remaining));
    return yield* supervised.pipe(Effect.timeout(Math.min(timeoutMs, remaining)));
  }).pipe(Effect.result);
  if (
    output._tag === "Success" &&
    output.success.outcome._tag === "Failure" &&
    output.success.outcome.failure._tag === "CheckpointReady"
  ) {
    const paused = output.success.outcome.failure;
    const saved = yield* Effect.tryPromise({
      try: () =>
        env.OBJECTS.put(
          key,
          Schema.encodeSync(Schema.fromJsonString(StoredRun))({
            ...record,
            status: "queued",
            authority: capability,
            deadlineAt: reservation.deadlineAt,
            stdinMode: reservation.stdinMode,
            checkpoint: paused.reference,
            checkpointCount: reservation.checkpointCount + 1,
            output: retained[0] ?? null,
          }),
          {
            onlyIf: { etagMatches: publication.etag },
            customMetadata: Schema.encodeSync(StoredRunMetadata)({
              format: "run-v5",
              summary: Struct.omit({ ...record, status: "queued" as const }, ["output"]),
            }),
          },
        ),
      catch: (cause) => new StorageFailure({ cause }),
    });
    if (saved !== null) {
      yield* Effect.tryPromise({
        try: () => env.EVENTS.send(Schema.encodeSync(ProcessDelivery)({ key, eTag: saved.etag })),
        catch: (cause) => new QueueFailure({ cause }),
      });
      return { ...record, status: "queued" as const };
    }
    const current = yield* Effect.tryPromise({
      try: () => env.OBJECTS.head(key),
      catch: (cause) => new StorageFailure({ cause }),
    });
    if (current === null)
      return yield* new StorageFailure({
        cause: "Process disappeared during checkpoint publication",
      });
    const metadata = yield* Schema.decodeUnknownEffect(StoredRunMetadata)(current.customMetadata);
    if (metadata.summary.status !== "cancelling")
      return yield* new Fault({
        code: "CONFLICT",
        status: 409,
        message: "Process changed during checkpoint publication",
      });
    publication.cancelled = true;
  }
  const snapshot = yield* Effect.gen(function* () {
    if (output._tag === "Success" && output.success.changed) {
      const hash = yield* archive(env, capability.sandboxId, output.success.program);
      return { ...record, sourceHash: hash };
    }
    return record;
  });
  const finishedAt = yield* Clock.currentTimeMillis;
  const finished = yield* Effect.sync(() => {
    if (publication.cancelled)
      return {
        ...snapshot,
        status: "cancelled" as const,
        finishedAt,
        output: snapshots[0] ?? null,
      };
    if (
      output._tag === "Failure" &&
      output.failure._tag === "Fault" &&
      output.failure.code === "ECANCELED"
    )
      return {
        ...snapshot,
        status: "cancelled" as const,
        finishedAt,
        output: snapshots[0] ?? null,
      };
    if (
      output._tag === "Success" &&
      output.success.outcome._tag === "Failure" &&
      output.success.outcome.failure._tag === "Fault" &&
      output.success.outcome.failure.code === "ECANCELED"
    )
      return {
        ...snapshot,
        status: "cancelled" as const,
        finishedAt,
        output: snapshots[0] ?? null,
      };
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

    return { ...snapshot, status: "failed" as const, finishedAt, output: snapshots[0] ?? null };
  });
  if (reservation.stdinMode === "pipe") yield* finishInput(env, capability.sandboxId, record.id);
  const settledOutput = yield* Effect.gen(function* () {
    if (finished.output === null) return null;
    if (
      finished.output.stdout === snapshots[0]?.stdout &&
      finished.output.stderr === snapshots[0]?.stderr
    )
      return yield* archiveOutput(
        env,
        capability.sandboxId,
        finished.output,
        retained[0] ?? null,
        captured[0] ?? null,
      );
    return yield* archiveOutput(env, capability.sandboxId, finished.output, retained[0] ?? null);
  });
  for (const attempt of [0, 1]) {
    const current = yield* Effect.tryPromise({
      try: () => env.OBJECTS.head(key),
      catch: (cause) => new StorageFailure({ cause }),
    });
    if (current === null)
      return yield* new StorageFailure({ cause: "Execution disappeared before settlement" });
    const metadata = yield* Schema.decodeUnknownEffect(StoredRunMetadata)(current.customMetadata);
    if (
      current.etag !== publication.etag &&
      (metadata.summary.status !== "cancelling" ||
        metadata.summary.id !== record.id ||
        metadata.summary.sourceHash !== record.sourceHash ||
        metadata.summary.startedAt !== record.startedAt ||
        metadata.summary.language !== record.language ||
        metadata.summary.finishedAt !== null)
    )
      return yield* new Fault({
        code: "CONFLICT",
        status: 409,
        message: "Execution state changed; inspect process.get",
      });
    const completed = yield* Effect.tryPromise({
      try: () =>
        env.OBJECTS.put(
          key,
          Schema.encodeSync(Schema.fromJsonString(StoredRun))({
            ...finished,
            output: settledOutput,
            authority: null,
            deadlineAt: null,
            stdinMode: reservation.stdinMode,
            checkpoint: null,
            checkpointCount: reservation.checkpointCount,
          }),
          {
            onlyIf: { etagMatches: current.etag },
            customMetadata: Schema.encodeSync(StoredRunMetadata)({
              format: "run-v5",
              summary: Struct.omit(finished, ["output"]),
            }),
          },
        ),
      catch: (cause) => new StorageFailure({ cause }),
    });
    if (completed !== null) return finished;
    if (attempt === 1)
      return yield* new Fault({
        code: "CONFLICT",
        status: 409,
        message: "Execution state changed; inspect process.get",
      });
  }
  return yield* new Fault({
    code: "CONFLICT",
    status: 409,
    message: "Execution settlement was not confirmed",
  });
});

export const run = Effect.fn("process.run")(function* (
  env: Env,
  capability: typeof Capability.Type,
  action: typeof RunAction.Type,
  host: HostBridge | null = null,
  timeoutMs: number | null = null,
  memoryLimitBytes: typeof Policy.Type.memoryBytes | null = null,
): Effect.fn.Return<
  typeof RunRecord.Type,
  Fault | StorageFailure | Schema.SchemaError | QueueFailure
> {
  const reservation = yield* Effect.scoped(
    reserve(env, capability, action, false, "closed", timeoutMs),
  );
  return yield* complete(env, capability, reservation, timeoutMs, host, memoryLimitBytes);
});

const readReceipt = Effect.fn("process.readReceipt")(function* (
  env: Env,
  capability: typeof Capability.Type,
  id: string,
) {
  yield* requirePermission(capability, "read");
  yield* head(env, capability.sandboxId);
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
    Effect.mapError((cause) => new StorageFailure({ cause })),
  );
});

export const recoveryStatus = Effect.fn("process.recoveryStatus")(function* (
  env: Env,
  capability: typeof Capability.Type,
  action: typeof ProcessRecoveryAction.Type,
) {
  const record = yield* readReceipt(env, capability, action.id);
  return {
    state: record.status,
    checkpoints: record.checkpointCount,
    resumable: record.status === "queued" && record.checkpoint !== null,
    deadlineAt: record.deadlineAt,
  };
});

export const inspect = Effect.fn("process.inspect")(function* (
  env: Env,
  capability: typeof Capability.Type,
  id: string,
) {
  const stored = yield* readReceipt(env, capability, id);
  const record = Struct.omit(stored, [
    "authority",
    "deadlineAt",
    "stdinMode",
    "checkpoint",
    "checkpointCount",
  ]);
  if (stored.output === null) return { ...record, output: null };
  return { ...record, output: yield* restoreOutput(env, capability.sandboxId, stored.output) };
});

export const list = Effect.fn("process.list")(function* (
  env: Env,
  capability: typeof Capability.Type,
  action: typeof ProcessListAction.Type,
) {
  yield* requirePermission(capability, "read");
  yield* head(env, capability.sandboxId);
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
    const record = yield* readReceipt(env, capability, action.id);
    const observedAt = yield* Clock.currentTimeMillis;
    if (capability.expiresAt <= observedAt)
      return yield* new Fault({ code: "UNAUTHORIZED", status: 401, message: "Capability expired" });
    if (record.status === "exited") {
      const summary = Struct.omit(record, [
        "authority",
        "deadlineAt",
        "stdinMode",
        "checkpoint",
        "checkpointCount",
      ]);
      if (record.output === null) return { ...summary, output: null };
      const output = yield* restoreOutput(env, capability.sandboxId, record.output);
      yield* requirePermission(capability, "read");
      return { ...summary, output };
    }
    if (record.status === "cancelled")
      return yield* new Fault({
        code: "ECANCELED",
        status: 409,
        message: "Execution was cancelled without a guest exit; inspect process.get",
      });
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
  const lifetime = yield* Effect.gen(function* () {
    if (stored.status !== "queued" || event.eTag !== object.etag) return null;
    return yield* observeDisposal(env, identity.sandboxId, null).pipe(Effect.result);
  });
  const disposed =
    lifetime !== null &&
    lifetime._tag === "Failure" &&
    lifetime.failure._tag === "Fault" &&
    lifetime.failure.code === "ECANCELED";
  if (lifetime !== null && lifetime._tag === "Failure" && !disposed) return yield* lifetime.failure;
  if (
    disposed ||
    (stored.deadlineAt !== null &&
      (stored.status === "running" ||
        stored.status === "cancelling" ||
        (stored.status === "queued" && now >= stored.deadlineAt)))
  ) {
    if (!disposed && stored.deadlineAt !== null && now < stored.deadlineAt)
      return yield* new ExecutionPending({
        retryAfterSeconds: Math.min(300, Math.max(1, Math.ceil((stored.deadlineAt - now) / 1000))),
      });
    const terminal = yield* Effect.sync(() => {
      if (disposed || stored.status === "cancelling") return "cancelled" as const;
      return "failed" as const;
    });
    const failed = {
      ...stored,
      status: terminal,
      authority: null,
      deadlineAt: null,
      finishedAt: now,
      output: stored.output,
      checkpoint: null,
    };
    const written = yield* Effect.tryPromise({
      try: () =>
        env.OBJECTS.put(event.key, Schema.encodeSync(Schema.fromJsonString(StoredRun))(failed), {
          onlyIf: { etagMatches: object.etag },
          customMetadata: Schema.encodeSync(StoredRunMetadata)({
            format: "run-v5",
            summary: Struct.omit(failed, [
              "output",
              "authority",
              "deadlineAt",
              "stdinMode",
              "checkpoint",
              "checkpointCount",
            ]),
          }),
        }),
      catch: (cause) => new StorageFailure({ cause }),
    });
    if (written === null) return yield* new ExecutionPending({ retryAfterSeconds: 1 });
    return;
  }
  if (stored.status !== "queued" || event.eTag !== object.etag) return;
  if (lifetime === null)
    return yield* new StorageFailure({ cause: "Queued lifetime was not observed" });
  if (lifetime._tag === "Failure") return yield* lifetime.failure;
  if (stored.authority === null || stored.authority.sandboxId !== identity.sandboxId)
    return yield* new StorageFailure({ cause: "Queued execution has no matching authority" });
  const capability = stored.authority;
  const program = yield* restore(env, capability.sandboxId, stored.sourceHash).pipe(Effect.result);
  if (program._tag === "Failure" && program.failure._tag === "ProgramVersionPending")
    return yield* new ExecutionPending({ retryAfterSeconds: 15 });
  if (stored.checkpoint !== null) {
    const checkpoint = yield* restoreExecutionCheckpoint(
      env.OBJECTS,
      capability.sandboxId,
      stored.checkpoint,
    ).pipe(Effect.result);
    if (checkpoint._tag === "Failure" && checkpoint.failure._tag === "CheckpointVersionPending")
      return yield* new ExecutionPending({ retryAfterSeconds: 15 });
  }
  const running = {
    ...stored,
    status: "running" as const,
    startedAt: yield* Effect.sync(() => {
      if (stored.checkpoint !== null) return stored.startedAt;
      return now;
    }),
    authority: null,
    checkpoint: null,
    deadlineAt: stored.deadlineAt ?? now + executionWindowMs,
  };
  const claimed = yield* Effect.tryPromise({
    try: () =>
      env.OBJECTS.put(event.key, Schema.encodeSync(Schema.fromJsonString(StoredRun))(running), {
        onlyIf: { etagMatches: object.etag },
        customMetadata: Schema.encodeSync(StoredRunMetadata)({
          format: "run-v5",
          summary: Struct.omit(running, [
            "output",
            "authority",
            "deadlineAt",
            "stdinMode",
            "checkpoint",
            "checkpointCount",
          ]),
        }),
      }),
    catch: (cause) => new StorageFailure({ cause }),
  });
  if (claimed === null) return;
  const record = {
    ...Struct.omit(running, [
      "authority",
      "deadlineAt",
      "stdinMode",
      "checkpoint",
      "checkpointCount",
    ]),
    output: yield* Effect.gen(function* () {
      if (running.output === null) return null;
      return yield* restoreOutput(env, capability.sandboxId, running.output);
    }),
  };
  yield* complete(
    env,
    capability,
    {
      record,
      etag: claimed.etag,
      sandboxEtag: lifetime.success,
      deadlineAt: running.deadlineAt,
      allowCheckpoint: true,
      stdinMode: running.stdinMode,
      checkpoint: stored.checkpoint,
      checkpointCount: stored.checkpointCount,
      retainedOutput: running.output,
      program: Effect.fromResult(program),
    },
    Math.max(1, Math.min(840_000, running.deadlineAt - now - 1000)),
  );
});

export class QueueFailure extends Schema.TaggedError<QueueFailure>()("QueueFailure", {
  cause: Schema.Unknown,
}) {}

export const spawn = Effect.fn("process.spawn")(function* (
  env: Env,
  capability: typeof Capability.Type,
  action: typeof RunAction.Type,
  stdinMode: typeof StoredRun.Type.stdinMode,
) {
  const reservation = yield* Effect.scoped(reserve(env, capability, action, true, stdinMode, null));
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
          if (
            metadata.summary.status !== "queued" &&
            metadata.summary.status !== "running" &&
            metadata.summary.status !== "cancelling"
          )
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
            ((record.status === "running" || record.status === "cancelling") &&
              record.deadlineAt !== null &&
              record.deadlineAt <= now)
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

export const cancel = Effect.fn("process.cancel")(function* (
  env: Env,
  capability: typeof Capability.Type,
  action: typeof ProcessCancelAction.Type,
) {
  yield* requirePermission(capability, "execute");
  yield* head(env, capability.sandboxId);
  const key = `processes/${capability.sandboxId}/${action.id}.json`;
  const object = yield* Effect.tryPromise({
    try: () => env.OBJECTS.get(key),
    catch: (cause) => new StorageFailure({ cause }),
  });
  if (object === null)
    return yield* new Fault({ code: "ENOENT", status: 404, message: "Execution does not exist" });
  if (object.size > 8_388_608)
    return yield* new StorageFailure({ cause: "Oversized process receipt" });
  const text = yield* Effect.tryPromise({
    try: () => object.text(),
    catch: (cause) => new StorageFailure({ cause }),
  });
  const stored = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(StoredRun))(text);
  if (stored.status !== "queued" && stored.status !== "running")
    return Struct.omit(stored, [
      "authority",
      "deadlineAt",
      "output",
      "stdinMode",
      "checkpoint",
      "checkpointCount",
    ]);
  const now = yield* Clock.currentTimeMillis;
  if (capability.expiresAt <= now)
    return yield* new Fault({ code: "UNAUTHORIZED", status: 401, message: "Capability expired" });
  const updated = yield* Effect.sync(() => {
    if (stored.status === "queued")
      return {
        ...stored,
        status: "cancelled" as const,
        authority: null,
        deadlineAt: null,
        finishedAt: now,
        output: stored.output,
        checkpoint: null,
      };
    return { ...stored, status: "cancelling" as const };
  });
  const receipt = yield* Effect.tryPromise({
    try: () =>
      env.OBJECTS.put(key, Schema.encodeSync(Schema.fromJsonString(StoredRun))(updated), {
        onlyIf: { etagMatches: object.etag },
        customMetadata: Schema.encodeSync(StoredRunMetadata)({
          format: "run-v5",
          summary: Struct.omit(updated, [
            "output",
            "authority",
            "deadlineAt",
            "stdinMode",
            "checkpoint",
            "checkpointCount",
          ]),
        }),
      }),
    catch: (cause) => new StorageFailure({ cause }),
  });
  if (receipt === null)
    return yield* new Fault({
      code: "CONFLICT",
      status: 409,
      message: "Execution changed during cancellation; inspect process.get",
    });
  return Struct.omit(updated, [
    "authority",
    "deadlineAt",
    "output",
    "stdinMode",
    "checkpoint",
    "checkpointCount",
  ]);
});

export const output = Effect.fn("process.output")(function* (
  env: Env,
  capability: typeof Capability.Type,
  action: typeof ProcessOutputAction.Type,
) {
  const record = yield* readReceipt(env, capability, action.id);
  const position = action.after ?? 0;
  if (record.output === null) {
    if (position !== 0)
      return yield* new Fault({
        code: "EINVAL",
        status: 400,
        message: "Output cursor is beyond retained bytes",
      });
    const availability = yield* Effect.sync(() => {
      if (
        record.status === "queued" ||
        record.status === "running" ||
        record.status === "cancelling"
      )
        return "pending" as const;
      return "unobserved" as const;
    });
    return {
      state: record.status,
      availability,
      events: [],
      nextCursor: 0,
      hasMore: false,
      truncated: false as const,
    };
  }
  if (
    record.output.exitCode === null &&
    record.status !== "failed" &&
    record.status !== "cancelled"
  )
    return yield* new Fault({
      code: "OUTPUT_PENDING",
      status: 409,
      message: "Use process.output.readLive for output checkpoints while running",
    });
  const stdoutSize = record.output.stdout.size;
  const stderrSize = record.output.stderr.size;
  const total = stdoutSize + stderrSize;
  if (position > total)
    return yield* new Fault({
      code: "EINVAL",
      status: 400,
      message: "Output cursor is beyond retained bytes",
    });
  const budget = Math.min(action.maxBytes, action.maxEvents * 4096);
  const stdoutOffset = Math.min(position, stdoutSize);
  const stdoutLength = Math.min(stdoutSize - stdoutOffset, budget);
  const stdout = yield* readOutputRange(
    env,
    capability.sandboxId,
    record.output.stdout,
    stdoutOffset,
    stdoutLength,
  );
  const stderrOffset = Math.max(0, position - stdoutSize);
  const stderrBudget = Math.min(
    action.maxBytes - stdoutLength,
    (action.maxEvents - Math.ceil(stdoutLength / 4096)) * 4096,
  );
  const stderrLength = Math.min(stderrSize - stderrOffset, stderrBudget);
  const stderr = yield* readOutputRange(
    env,
    capability.sandboxId,
    record.output.stderr,
    stderrOffset,
    stderrLength,
  );
  const events: (typeof ProcessOutputPage.Type.events)[number][] = [];
  const progress = { position, bytes: 0 };
  while (
    progress.position < total &&
    progress.bytes < action.maxBytes &&
    events.length < action.maxEvents
  ) {
    const stream = yield* Effect.sync(() => {
      if (progress.position < stdoutSize)
        return { name: "stdout" as const, data: stdout, start: 0, loadedAt: stdoutOffset };
      return { name: "stderr" as const, data: stderr, start: stdoutSize, loadedAt: stderrOffset };
    });
    const offset = progress.position - stream.start;
    const length = Math.min(
      4096,
      action.maxBytes - progress.bytes,
      stream.data.byteLength - (offset - stream.loadedAt),
    );
    events.push({
      stream: stream.name,
      offset,
      cursor: progress.position,
      data: stream.data
        .subarray(offset - stream.loadedAt, offset - stream.loadedAt + length)
        .toString("base64"),
      encoding: "base64",
    });
    progress.position += length;
    progress.bytes += length;
  }
  return {
    state: record.status,
    availability: "retained" as const,
    events,
    nextCursor: progress.position,
    hasMore: progress.position < total,
    truncated: false as const,
  };
});

export const liveOutput = Effect.fn("process.liveOutput")(function* (
  env: Env,
  capability: typeof Capability.Type,
  action: typeof ProcessLiveOutputAction.Type,
) {
  const record = yield* readReceipt(env, capability, action.id);
  const progress = {
    stdout: action.after?.stdout ?? 0,
    stderr: action.after?.stderr ?? 0,
    bytes: 0,
  };
  const sizes = {
    stdout: record.output?.stdout.size ?? 0,
    stderr: record.output?.stderr.size ?? 0,
  };
  if (progress.stdout > sizes.stdout || progress.stderr > sizes.stderr)
    return yield* new Fault({
      code: "EINVAL",
      status: 400,
      message: "Output cursor is beyond captured bytes",
    });
  const budget = Math.min(action.maxBytes, action.maxEvents * 4096);
  const loadedAt = { stdout: progress.stdout, stderr: progress.stderr };
  const stdoutLength = Math.min(sizes.stdout - progress.stdout, budget);
  const stderrBudget = Math.min(
    action.maxBytes - stdoutLength,
    (action.maxEvents - Math.ceil(stdoutLength / 4096)) * 4096,
  );
  const stderrLength = Math.min(sizes.stderr - progress.stderr, stderrBudget);
  const buffers = yield* Effect.gen(function* () {
    if (record.output === null) return { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
    const stdout = yield* readOutputRange(
      env,
      capability.sandboxId,
      record.output.stdout,
      progress.stdout,
      stdoutLength,
    );
    const stderr = yield* readOutputRange(
      env,
      capability.sandboxId,
      record.output.stderr,
      progress.stderr,
      stderrLength,
    );
    return { stdout, stderr };
  });
  const events: (typeof LiveOutputPage.Type.events)[number][] = [];
  for (const stream of ["stdout", "stderr"] as const) {
    while (
      progress[stream] < sizes[stream] &&
      progress.bytes < action.maxBytes &&
      events.length < action.maxEvents
    ) {
      const offset = progress[stream];
      const length = Math.min(
        4096,
        action.maxBytes - progress.bytes,
        buffers[stream].byteLength - (offset - loadedAt[stream]),
      );
      events.push({
        stream,
        offset,
        cursor: offset,
        data: buffers[stream]
          .subarray(offset - loadedAt[stream], offset - loadedAt[stream] + length)
          .toString("base64"),
        encoding: "base64",
      });
      progress[stream] += length;
      progress.bytes += length;
    }
  }
  const availability = yield* Effect.sync(() => {
    if (record.output !== null) return "retained" as const;
    if (record.status === "queued" || record.status === "running" || record.status === "cancelling")
      return "pending" as const;
    return "unobserved" as const;
  });
  return {
    state: record.status,
    availability,
    events,
    nextCursor: { stdout: progress.stdout, stderr: progress.stderr },
    hasMore: progress.stdout < sizes.stdout || progress.stderr < sizes.stderr,
    truncated: false as const,
  };
});
