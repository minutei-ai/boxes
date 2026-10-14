import { Clock, Config, Effect, Redacted, Schedule } from "effect";
import { FetchHttpClient } from "effect/http";
import { make } from "../dist/sdk/sdk.js";

await Effect.runPromise(
  Effect.gen(function* () {
    const url = yield* Config.String("CIRRO_URL");
    const token = yield* Config.Redacted("CIRRO_API_KEY");
    const admin = yield* make({ url, token });
    const id = `cron-${crypto.randomUUID()}`;
    yield* admin.create({
      id,
      policy: {
        networkHosts: [],
        interruptBudget: 1000,
        memoryBytes: 8388608,
        maxOutputBytes: 1048576,
      },
    });
    const grant = yield* admin.mintCapability(id, {
      permissions: ["read", "execute", "manage"],
      expiresInSeconds: 600,
    });
    const boxes = yield* make({ url, token: Redacted.make(grant.token) });
    const now = yield* Clock.currentTimeMillis;
    const execution = { op: "typescript.evaluate", id: "seed", expression: "6 * 7" } as const;
    const scheduled = yield* boxes.action(id, {
      op: "cron.schedule",
      id: "one-shot",
      schedule: new Date(now + 30000).toISOString(),
      execution,
      overlap: "allow",
    });
    if (scheduled.state !== "active" || scheduled.runCount !== 0)
      return yield* Effect.die("Schedule not registered");
    const invalid = yield* boxes
      .action(id, {
        op: "cron.schedule",
        id: "invalid",
        schedule: "61 * * * *",
        execution,
        overlap: "allow",
      })
      .pipe(Effect.flip);
    if (invalid._tag !== "BoxesError" || invalid.status !== 400)
      return yield* Effect.die("Invalid cron accepted");
    const fired = yield* boxes.action(id, { op: "cron.get", id: "one-shot" }).pipe(
      Effect.repeat({
        while: (job) => job.state === "active",
        schedule: Schedule.spaced("2 seconds"),
      }),
      Effect.timeout("180 seconds"),
    );
    if (fired.state !== "completed" || fired.runCount !== 1 || fired.lastProcessId === null)
      return yield* Effect.die("Occurrence not admitted once");
    const process = yield* boxes.action(id, {
      op: "process.wait",
      id: fired.lastProcessId,
      timeoutMs: 25000,
    });
    if (process.status !== "exited" || process.output?.result !== 42)
      return yield* Effect.die("Scheduled execution did not complete");
    yield* boxes.action(id, {
      op: "cron.schedule",
      id: "cancelled",
      schedule: new Date(now + 300000).toISOString(),
      execution,
      overlap: "skip",
    });
    yield* boxes.action(id, { op: "cron.cancel", id: "cancelled" });
    const page = yield* boxes.action(id, { op: "cron.list", limit: 1 });
    if (
      page.jobs.length !== 1 ||
      page.jobs[0].id !== "cancelled" ||
      page.jobs[0].state !== "cancelled" ||
      page.cursor === null
    )
      return yield* Effect.die("Schedule pagination or cancellation differs");
    const last = yield* boxes.action(id, { op: "cron.list", limit: 1, cursor: page.cursor });
    if (last.jobs[0]?.id !== "one-shot" || last.cursor !== null)
      return yield* Effect.die("Schedule cursor differs");
    yield* boxes.action(id, { op: "vm.dispose" });
    console.log(
      JSON.stringify({
        checks: 6,
        passed: true,
        target: "production",
        feature: "cron",
        nativeScheduledDelivery: true,
        result: 42,
      }),
    );
  }).pipe(Effect.provide(FetchHttpClient.layer)),
);
