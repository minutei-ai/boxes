import { Clock, Cron, Effect, Schema, Struct } from "effect";
import { CryptoFailure, requirePermission } from "./auth";
import {
  Capability,
  CronAction,
  CronRecord,
  CronPage,
  Fault,
  StoredCron,
  StoredCronMetadata,
} from "./contracts";
import { head, StorageFailure } from "./storage";
import { referenceContext } from "./contexts";
import { inspect, spawn } from "./process";
import type { Env } from "./resources";

const nextRun = Effect.fn("cron.nextRun")(function* (schedule: string, after: number) {
  const text = schedule.trim();
  if (/^\d{4}-\d{2}-\d{2}(?:[T ].*)?$/.test(text)) {
    const normalized = text.replace(" ", "T");
    const date = yield* Schema.decodeUnknownEffect(Schema.DateFromString)(
      normalized.replace(/(T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?)$/, "$1Z"),
    ).pipe(
      Effect.mapError(
        () => new Fault({ code: "EINVAL", status: 400, message: "Invalid one-shot schedule" }),
      ),
    );
    if (date.getTime() <= after) return null;
    return date.getTime();
  }
  if (text.split(/\s+/).length !== 5)
    return yield* new Fault({
      code: "EINVAL",
      status: 400,
      message: "Schedule requires five UTC cron fields or an ISO timestamp",
    });
  const parsed = yield* Effect.fromResult(Cron.parse(text, "UTC")).pipe(
    Effect.mapError((cause) => new Fault({ code: "EINVAL", status: 400, message: cause.message })),
  );
  return yield* Effect.try({
    try: () => Cron.next(parsed, new Date(after)).getTime(),
    catch: () =>
      new Fault({
        code: "EINVAL",
        status: 400,
        message: "Cron expression has no future occurrence",
      }),
  });
});

const load = Effect.fn("cron.load")(function* (env: Env, key: string) {
  const object = yield* Effect.tryPromise({
    try: () => env.OBJECTS.get(key),
    catch: (cause) => new StorageFailure({ cause }),
  });
  if (object === null)
    return yield* new Fault({ code: "ENOENT", status: 404, message: "Schedule not found" });
  if (object.size > 22_400_000) return yield* new StorageFailure({ cause: "Oversized schedule" });
  const text = yield* Effect.tryPromise({
    try: () => object.text(),
    catch: (cause) => new StorageFailure({ cause }),
  });
  const stored = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(StoredCron))(text);
  if (key !== `schedules/${stored.authority.sandboxId}/${stored.id}.json`)
    return yield* new StorageFailure({ cause: "Schedule identity differs from its storage key" });
  return { stored, etag: object.etag };
});

const publish = Effect.fn("cron.publish")(function* (
  env: Env,
  key: string,
  stored: typeof StoredCron.Type,
  etag: string | null,
) {
  const condition = yield* Effect.sync(() => {
    if (etag === null) return { etagDoesNotMatch: "*" };
    return { etagMatches: etag };
  });
  return yield* Effect.tryPromise({
    try: () =>
      env.OBJECTS.put(key, Schema.encodeSync(Schema.fromJsonString(StoredCron))(stored), {
        onlyIf: condition,
        customMetadata: Schema.encodeSync(StoredCronMetadata)({
          format: "cron-v2",
          summary: { state: stored.state, nextRun: stored.nextRun },
        }),
      }),
    catch: (cause) => new StorageFailure({ cause }),
  });
});

export const cron = Effect.fn("cron.action")(function* (
  env: Env,
  capability: typeof Capability.Type,
  action: typeof CronAction.Type,
) {
  yield* requirePermission(capability, "manage");
  yield* head(env, capability.sandboxId);
  const prefix = `schedules/${capability.sandboxId}/`;
  if (action.op === "cron.list") {
    const page = yield* Effect.tryPromise({
      try: () => env.OBJECTS.list({ prefix, limit: action.limit, cursor: action.cursor }),
      catch: (cause) => new StorageFailure({ cause }),
    });
    const jobs = yield* Effect.forEach(
      page.objects,
      (object) =>
        load(env, object.key).pipe(
          Effect.map(({ stored }) => Struct.omit(stored, ["authority", "pendingAt"])),
        ),
      { concurrency: 4 },
    );
    if (page.truncated) return { jobs, cursor: page.cursor } satisfies typeof CronPage.Type;
    return { jobs, cursor: null } satisfies typeof CronPage.Type;
  }
  const key = `${prefix}${action.id}.json`;
  if (action.op === "cron.schedule") {
    yield* requirePermission(capability, "execute");
    yield* requirePermission(capability, "read");
    const context = yield* referenceContext(env, capability, action.execution);
    const now = yield* Clock.currentTimeMillis;
    const due = yield* nextRun(action.schedule, now);
    if (due === null || due >= capability.expiresAt)
      return yield* new Fault({
        code: "EINVAL",
        status: 400,
        message: "First occurrence must be in the future and within the capability lifetime",
      });
    const stored: typeof StoredCron.Type = {
      ...action,
      context,
      state: "active",
      createdAt: now,
      nextRun: due,
      lastRun: null,
      runCount: 0,
      lastProcessId: null,
      error: null,
      authority: capability,
      pendingAt: null,
    };
    const object = yield* publish(env, key, stored, null);
    if (object === null)
      return yield* new Fault({
        code: "EEXIST",
        status: 409,
        message: "Schedule ID already exists",
      });
    return Struct.omit(stored, ["authority", "pendingAt"]);
  }
  const current = yield* load(env, key);
  if (action.op === "cron.get") return Struct.omit(current.stored, ["authority", "pendingAt"]);
  if (current.stored.state !== "cancelled") {
    const object = yield* publish(
      env,
      key,
      { ...current.stored, state: "cancelled", nextRun: null },
      current.etag,
    );
    if (object === null)
      return yield* new Fault({
        code: "CONFLICT",
        status: 409,
        message: "Schedule changed concurrently; inspect current state",
      });
  }
  return { ok: true };
});

const fire = Effect.fn("cron.fire")(function* (env: Env, key: string, now: number) {
  const current = yield* load(env, key);
  const job = current.stored;
  if (job.state !== "active" || job.nextRun === null || job.nextRun > now) return;
  if (job.authority.expiresAt <= now) {
    yield* publish(env, key, { ...job, state: "expired", nextRun: null }, current.etag);
    return;
  }
  const sandbox = yield* head(env, job.authority.sandboxId).pipe(Effect.result);
  if (sandbox._tag === "Failure") {
    if (sandbox.failure._tag === "Fault" && sandbox.failure.code === "ENOENT") {
      yield* publish(
        env,
        key,
        {
          ...job,
          state: "cancelled",
          nextRun: null,
          pendingAt: null,
          error: sandbox.failure.message,
        },
        current.etag,
      );
      return;
    }
    return yield* Effect.fail(sandbox.failure);
  }
  if (job.pendingAt === null && job.overlap !== "allow" && job.lastProcessId !== null) {
    const previous = yield* inspect(env, job.authority, job.lastProcessId);
    if (["queued", "running", "cancelling"].includes(previous.status)) {
      if (job.overlap === "queue") return;
      const due = yield* nextRun(job.schedule, now);
      const state = yield* Effect.sync(() => {
        if (due === null) return "completed" as const;
        return "active" as const;
      });
      yield* publish(env, key, { ...job, nextRun: due, state }, current.etag);
      return;
    }
  }
  const claim = yield* publish(env, key, { ...job, pendingAt: job.nextRun }, current.etag);
  if (claim === null) return;
  const digest = yield* Effect.tryPromise({
    try: () =>
      crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(`${key}:${job.nextRun}:${job.execution.id}`),
      ),
    catch: (cause) => new CryptoFailure({ cause }),
  });
  const id = `cron-${Buffer.from(digest).toString("hex").slice(0, 58)}`;
  const launched = yield* spawn(
    env,
    job.authority,
    { ...job.execution, id },
    "closed",
    job.context,
  ).pipe(
    Effect.catchTag("Fault", (failure) =>
      inspect(env, job.authority, id).pipe(
        Effect.flatMap((record) => {
          if (!Schema.toEquivalence(CronRecord.fields.context)(record.context, job.context))
            return Effect.fail(
              new Fault({
                code: "CONFLICT",
                status: 409,
                message: "Reserved occurrence belongs to another context",
              }),
            );
          return Effect.succeed(record);
        }),
        Effect.catchTag("Fault", (observed) => {
          if (observed.code === "ENOENT") return Effect.fail(failure);
          return Effect.fail(observed);
        }),
      ),
    ),
    Effect.result,
  );
  if (launched._tag === "Failure") {
    if (launched.failure._tag === "Fault") {
      if (launched.failure.code === "CHECKPOINT_MIGRATION_PENDING") return;
      yield* publish(
        env,
        key,
        {
          ...job,
          state: "failed",
          nextRun: null,
          pendingAt: null,
          error: launched.failure.message,
        },
        claim.etag,
      );
      return;
    }
    return yield* Effect.fail(launched.failure);
  }
  const due = yield* nextRun(job.schedule, job.nextRun);
  const state = yield* Effect.sync(() => {
    if (due === null) return "completed" as const;
    return "active" as const;
  });
  yield* publish(
    env,
    key,
    {
      ...job,
      state,
      nextRun: due,
      lastRun: job.nextRun,
      pendingAt: null,
      runCount: job.runCount + 1,
      lastProcessId: id,
    },
    claim.etag,
  );
});

export const tick = Effect.fn("cron.tick")(function* (env: Env) {
  const now = yield* Clock.currentTimeMillis;
  const cursors: (string | undefined)[] = [undefined];
  while (cursors.length > 0) {
    const cursor = cursors.shift();
    const page = yield* Effect.tryPromise({
      try: () =>
        env.OBJECTS.list({
          prefix: "schedules/",
          cursor,
          limit: 1000,
          include: ["customMetadata"],
        }),
      catch: (cause) => new StorageFailure({ cause }),
    });
    yield* Effect.forEach(
      page.objects,
      (object) =>
        Effect.gen(function* () {
          const metadata = yield* Schema.decodeUnknownEffect(StoredCronMetadata)(
            object.customMetadata,
          );
          if (
            metadata.summary.state !== "active" ||
            metadata.summary.nextRun === null ||
            metadata.summary.nextRun > now
          )
            return;
          yield* fire(env, object.key, now).pipe(
            Effect.catchTag("Fault", (failure) => {
              if (failure.code === "ENOENT") return Effect.void;
              return Effect.fail(failure);
            }),
          );
        }),
      { concurrency: 4 },
    );
    if (page.truncated) cursors.push(page.cursor);
  }
});
