import { afterAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Layer, Redacted, Schema } from "effect";
import { FetchHttpClient } from "effect/http";
import { make } from "../src/sdk";
import { ProcessDelivery, StoredCron } from "../src/contracts";
import { runtime } from "../tooling/worker-test";

const directory = await mkdtemp(join(tmpdir(), "boxes-cron-"));
const first = runtime(directory);
const instances = [first];
const transport = FetchHttpClient.layer.pipe(
  Layer.provide(Layer.succeed(FetchHttpClient.RequestInit, { keepalive: false })),
);
const run = <A, E>(program: Effect.Effect<A, E, import("effect/http/HttpClient").HttpClient>) =>
  Effect.runPromise(program.pipe(Effect.provide(transport)));
const admin = await run(
  make({
    url: (await first.ready).toString(),
    token: Redacted.make("cirro-local-test-credential"),
  }),
);
const policy = {
  networkHosts: [],
  interruptBudget: 1000,
  memoryBytes: 8388608,
  maxOutputBytes: 1048576,
};
const client = async (id: string) => {
  await run(admin.create({ id, policy }));
  const grant = await run(
    admin.mintCapability(id, {
      permissions: ["read", "write", "execute", "manage"],
      expiresInSeconds: 3600,
    }),
  );
  const boxes = await run(
    make({ url: (await first.ready).toString(), token: Redacted.make(grant.token) }),
  );
  return { boxes, grant };
};
const execution = { op: "typescript.evaluate", id: "seed", expression: "6 * 7" } as const;
const deliver = async (instance: ReturnType<typeof runtime>, sandboxId: string, id: string) => {
  const key = `processes/${sandboxId}/${id}.json`;
  const object = await (await instance.objects).head(key);
  if (object === null) return expect(object).not.toBeNull();
  await (
    await instance.control
  ).deliver("executions", [
    {
      id: "cron",
      timestamp: new Date(),
      attempts: 1,
      body: Schema.encodeSync(ProcessDelivery)({ key, eTag: object.etag }),
    },
  ]);
};
afterAll(async () => {
  for (const instance of instances) await instance.dispose();
  await rm(directory, { recursive: true, force: true });
});

test("one-shot schedule reserves one process across concurrent ticks and repeated queue deliveries", async () => {
  const { boxes } = await client("cron-once");
  const due = first.time + 120000;
  await run(
    boxes.action("cron-once", {
      op: "filesystem.writeFile",
      path: "/count",
      content: "",
      encoding: "utf8",
    }),
  );
  const scheduled = await run(
    boxes.action("cron-once", {
      op: "cron.schedule",
      id: "once",
      schedule: new Date(due).toISOString(),
      overlap: "allow",
      execution: {
        op: "process.run",
        id: "append",
        language: "typescript",
        source:
          'export default async ({ tools }) => tools.call({ op: "filesystem.appendFile", path: "/count", content: "x" })',
      },
    }),
  );
  expect(scheduled.nextRun).toBe(due);
  expect("authority" in scheduled).toBe(false);
  const control = await first.control;
  await control.schedules(due - 1);
  expect((await run(boxes.action("cron-once", { op: "cron.get", id: "once" }))).runCount).toBe(0);
  await Promise.all([control.schedules(due), control.schedules(due)]);
  await control.schedules(due + 1);
  const fired = await run(boxes.action("cron-once", { op: "cron.get", id: "once" }));
  expect([fired.state, fired.runCount, fired.nextRun]).toEqual(["completed", 1, null]);
  if (fired.lastProcessId === null) return expect(fired.lastProcessId).not.toBeNull();
  await deliver(first, "cron-once", fired.lastProcessId);
  await deliver(first, "cron-once", fired.lastProcessId);
  const bytes = await run(boxes.action("cron-once", { op: "filesystem.readFile", path: "/count" }));
  expect(Buffer.from(bytes.content, bytes.encoding).toString()).toBe("x");
});

test("cron grammar, pagination, cancellation and scoped authorization consume their contracts", async () => {
  const { boxes } = await client("cron-control");
  for (const schedule of [
    "bad",
    "* * * * * *",
    "61 * * * *",
    "0 0 31 2 *",
    "2000-01-01",
    "2999-01-01",
  ])
    expect(
      await run(
        boxes
          .action("cron-control", {
            op: "cron.schedule",
            id: "invalid",
            schedule,
            execution,
            overlap: "allow",
          })
          .pipe(Effect.flip),
      ),
    ).toMatchObject({ _tag: "BoxesError", status: 400 });
  const one = await run(
    boxes.action("cron-control", {
      op: "cron.schedule",
      id: "a",
      schedule: "*/2 * * * *",
      execution,
      overlap: "allow",
    }),
  );
  expect(one.nextRun).toBeGreaterThan(first.time);
  await run(
    boxes.action("cron-control", {
      op: "cron.schedule",
      id: "b",
      schedule: "* * * * *",
      execution,
      overlap: "allow",
    }),
  );
  expect(
    await run(
      boxes
        .action("cron-control", {
          op: "cron.schedule",
          id: "a",
          schedule: "* * * * *",
          execution,
          overlap: "allow",
        })
        .pipe(Effect.flip),
    ),
  ).toMatchObject({ status: 409 });
  const page = await run(boxes.action("cron-control", { op: "cron.list", limit: 1 }));
  expect(page.jobs.map((job) => job.id)).toEqual(["a"]);
  if (page.cursor === null) return expect(page.cursor).not.toBeNull();
  const last = await run(
    boxes.action("cron-control", { op: "cron.list", limit: 1, cursor: page.cursor }),
  );
  expect(last.jobs.map((job) => job.id)).toEqual(["b"]);
  expect(last.cursor).toBeNull();
  await run(boxes.action("cron-control", { op: "cron.cancel", id: "a" }));
  await run(boxes.action("cron-control", { op: "cron.cancel", id: "a" }));
  expect((await run(boxes.action("cron-control", { op: "cron.get", id: "a" }))).state).toBe(
    "cancelled",
  );
  const limited = await run(
    admin.mintCapability("cron-control", {
      permissions: ["read", "execute"],
      expiresInSeconds: 600,
    }),
  );
  const reader = await run(
    make({ url: (await first.ready).toString(), token: Redacted.make(limited.token) }),
  );
  expect(
    await run(reader.action("cron-control", { op: "cron.list", limit: 1 }).pipe(Effect.flip)),
  ).toMatchObject({ status: 403 });
  expect(
    await run(reader.action("cron-once", { op: "cron.get", id: "once" }).pipe(Effect.flip)),
  ).toMatchObject({ status: 401 });
  await run(boxes.action("cron-control", { op: "cron.cancel", id: "b" }));
});

test("skip and queue overlap use persisted process status and expiry never creates a new execution", async () => {
  const { boxes } = await client("cron-overlap");
  const skip = await run(
    boxes.action("cron-overlap", {
      op: "cron.schedule",
      id: "skip",
      schedule: "* * * * *",
      execution,
      overlap: "skip",
    }),
  );
  const queued = await run(
    boxes.action("cron-overlap", {
      op: "cron.schedule",
      id: "queue",
      schedule: "* * * * *",
      execution,
      overlap: "queue",
    }),
  );
  if (skip.nextRun === null || queued.nextRun === null) return expect(skip.nextRun).not.toBeNull();
  const due = Math.max(skip.nextRun, queued.nextRun);
  const control = await first.control;
  await control.schedules(due);
  await control.schedules(due + 60000);
  const skipped = await run(boxes.action("cron-overlap", { op: "cron.get", id: "skip" }));
  const waiting = await run(boxes.action("cron-overlap", { op: "cron.get", id: "queue" }));
  expect(skipped.runCount).toBe(1);
  expect(skipped.nextRun).toBeGreaterThan(due + 60000);
  expect(waiting.runCount).toBe(1);
  expect(waiting.nextRun).toBe(due + 60000);
  if (waiting.lastProcessId === null) return expect(waiting.lastProcessId).not.toBeNull();
  await deliver(first, "cron-overlap", waiting.lastProcessId);
  await control.schedules(due + 60000);
  expect((await run(boxes.action("cron-overlap", { op: "cron.get", id: "queue" }))).runCount).toBe(
    2,
  );
  await control.schedules(first.time + 3700000);
  expect((await run(boxes.action("cron-overlap", { op: "cron.get", id: "skip" }))).state).toBe(
    "expired",
  );
  expect((await run(boxes.action("cron-overlap", { op: "cron.get", id: "queue" }))).runCount).toBe(
    2,
  );
});

test("disposed sandboxes and invalid executable sources stop scheduling without admitting a process", async () => {
  const { boxes } = await client("cron-disposed");
  const due = first.time + 120000;
  await run(
    boxes.action("cron-disposed", {
      op: "cron.schedule",
      id: "disposed",
      schedule: new Date(due).toISOString(),
      execution,
      overlap: "allow",
    }),
  );
  await run(boxes.action("cron-disposed", { op: "vm.dispose" }));
  await (await first.control).schedules(due);
  const bucket = await first.objects;
  const object = await bucket.get("schedules/cron-disposed/disposed.json");
  if (object === null) return expect(object).not.toBeNull();
  const cancelled = Schema.decodeUnknownSync(Schema.fromJsonString(StoredCron))(
    await object.text(),
  );
  expect([cancelled.state, cancelled.runCount]).toEqual(["cancelled", 0]);
  expect((await bucket.list({ prefix: "processes/cron-disposed/" })).objects.length).toBe(0);
  const { boxes: invalid } = await client("cron-invalid-source");
  await run(
    invalid.action("cron-invalid-source", {
      op: "cron.schedule",
      id: "missing",
      schedule: new Date(due).toISOString(),
      execution: { op: "typescript.executeFile", id: "seed", path: "/missing.ts" },
      overlap: "allow",
    }),
  );
  await (await first.control).schedules(due);
  const failed = await run(
    invalid.action("cron-invalid-source", { op: "cron.get", id: "missing" }),
  );
  expect([failed.state, failed.runCount, failed.nextRun]).toEqual(["failed", 0, null]);
  expect(failed.error).not.toBeNull();
});

test("replacement Worker recovers a claimed occurrence with an already reserved execution", async () => {
  const { boxes, grant } = await client("cron-recovery");
  const due = first.time + 120000;
  await run(
    boxes.action("cron-recovery", {
      op: "cron.schedule",
      id: "retained",
      schedule: new Date(due).toISOString(),
      execution,
      overlap: "allow",
    }),
  );
  const key = "schedules/cron-recovery/retained.json";
  const bucket = await first.objects;
  const object = await bucket.get(key);
  if (object === null) return expect(object).not.toBeNull();
  const stored = Schema.decodeUnknownSync(Schema.fromJsonString(StoredCron))(await object.text());
  await bucket.put(
    key,
    Schema.encodeSync(Schema.fromJsonString(StoredCron))({ ...stored, pendingAt: due }),
    { customMetadata: object.customMetadata },
  );
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`${key}:${due}:${execution.id}`),
  );
  const id = `cron-${Buffer.from(digest).toString("hex").slice(0, 58)}`;
  await run(
    boxes.action("cron-recovery", { op: "process.spawn", execution: { ...execution, id } }),
  );
  await first.dispose();
  const second = runtime(directory, { clockStart: first.time });
  instances.splice(0, 1, second);
  await (await second.control).schedules(due);
  const replacement = await run(
    make({ url: (await second.ready).toString(), token: Redacted.make(grant.token) }),
  );
  const job = await run(replacement.action("cron-recovery", { op: "cron.get", id: "retained" }));
  expect([job.state, job.runCount, job.lastProcessId]).toEqual(["completed", 1, id]);
  await deliver(second, "cron-recovery", id);
  const result = await run(replacement.action("cron-recovery", { op: "process.get", id }));
  expect(result.status).toBe("exited");
  expect(result.output?.result).toBe(42);
});
