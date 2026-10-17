import { Clock, Effect, Redacted, Schedule, Schema, Struct } from "effect";
import { makeAgentBinding } from "../../src/sdk-rpc";
import { AgentRequest, ContextRecord, CronRecord, RunRecord } from "../../src/contracts";
import type { AgentProtocol } from "../../src/rpc-protocol";

export const QueuedBindingInput = Schema.Struct({
  ...AgentRequest.mapFields((fields) => Struct.pick(fields, ["sandboxId", "token"])).fields,
  phase: Schema.Literals(["create", "verify"]),
});
export const QueuedBindingCreated = Schema.Struct({
  phase: Schema.Literal("create"),
  callbacks: Schema.Literal(1),
  queued: Schema.Array(RunRecord).check(Schema.isMinLength(2), Schema.isMaxLength(2)),
  schedule: CronRecord,
}).check(
  Schema.makeFilter(
    (proof) =>
      proof.queued.every(
        (record) => record.status === "queued" && record.context?.generation === 0,
      ) && proof.schedule.context?.generation === 0,
  ),
);
export const QueuedBindingVerified = Schema.Struct({
  phase: Schema.Literal("verify"),
  queued: Schema.Array(RunRecord).check(Schema.isMinLength(2), Schema.isMaxLength(2)),
  continued: Schema.Array(RunRecord).check(Schema.isMinLength(2), Schema.isMaxLength(2)),
  schedule: CronRecord,
  scheduledProcess: RunRecord,
  staleSchedule: CronRecord,
  staleContext: ContextRecord,
  staleFileExists: Schema.Literal(false),
}).check(
  Schema.makeFilter(
    (proof) =>
      proof.queued.every((record) => record.status === "exited" && record.output?.exitCode === 0) &&
      Schema.is(Schema.Struct({ value: Schema.Literal(41), denied: Schema.Literal("FORBIDDEN") }))(
        proof.queued[0]?.output?.result,
      ) &&
      proof.queued[1]?.output?.result === 41 &&
      proof.continued.every(
        (record) =>
          record.status === "exited" &&
          record.output?.exitCode === 0 &&
          record.output.result === 42,
      ) &&
      proof.schedule.state === "completed" &&
      proof.schedule.runCount === 1 &&
      proof.scheduledProcess.status === "exited" &&
      proof.scheduledProcess.output?.result === 41 &&
      proof.staleSchedule.state === "failed" &&
      proof.staleSchedule.runCount === 0 &&
      proof.staleSchedule.lastProcessId === null &&
      proof.staleContext.generation === 1 &&
      proof.staleContext.state === "idle",
  ),
);
export const QueuedBindingReply = Schema.Union([QueuedBindingCreated, QueuedBindingVerified]);

export const queuedBindingProof = Effect.fn("fixture.queuedBindingProof")(function* (
  request: Request,
  binding: Fetcher<AgentProtocol>,
) {
  const input = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(QueuedBindingInput), {
    onExcessProperty: "error",
  })(yield* Effect.promise(() => request.text()));
  const boxes = yield* makeAgentBinding(binding, Redacted.make(input.token));
  if (input.phase === "create") {
    for (const id of ["detached-js", "detached-cron", "detached-stale"])
      yield* boxes.action(input.sandboxId, { op: "contexts.create", id });
    yield* boxes.action(input.sandboxId, {
      op: "contexts.create",
      id: "detached-python",
      language: "python",
    });
    const callbacks = { count: 0 };
    const seeded = yield* boxes.runWithTools(
      input.sandboxId,
      {
        id: "detached-seed-js",
        contextId: "detached-js",
        tools: ["lookup"],
        maxToolCalls: 1,
        timeoutMs: 25000,
        source:
          "export default async({tools})=>{let value=40;globalThis.next=()=>++value;globalThis.saved=()=>tools.call({op:'host.call',name:'lookup'});return await globalThis.saved();}",
      },
      async () => {
        callbacks.count += 1;
        return { ok: true, value: 11 };
      },
    );
    if (seeded.output?.result !== 11) return yield* Effect.die("Detached callback seed failed");
    yield* boxes.action(input.sandboxId, {
      op: "python.execute",
      id: "detached-seed-python",
      contextId: "detached-python",
      source:
        "def factory():\n n=40\n def next():\n  nonlocal n\n  n+=1\n  return n\n return next\nnext_value=factory()\n0",
    });
    yield* boxes.action(input.sandboxId, {
      op: "javascript.execute",
      id: "detached-seed-cron",
      contextId: "detached-cron",
      source: "let value=40;globalThis.next=()=>++value;",
    });
    const queued = [
      yield* boxes.action(input.sandboxId, {
        op: "process.spawn",
        execution: {
          op: "typescript.evaluate",
          id: "detached-queued-js",
          contextId: "detached-js",
          expression:
            "({value:globalThis.next(),denied:await globalThis.saved().catch(error=>error.code)})",
        },
      }),
      yield* boxes.action(input.sandboxId, {
        op: "process.spawn",
        execution: {
          op: "python.evaluate",
          id: "detached-queued-python",
          contextId: "detached-python",
          expression: "next_value()",
        },
      }),
    ];
    const due = (yield* Clock.currentTimeMillis) + 2000;
    const schedule = yield* boxes.action(input.sandboxId, {
      op: "cron.schedule",
      id: "detached-once",
      schedule: new Date(due).toISOString(),
      overlap: "queue",
      execution: {
        op: "javascript.evaluate",
        id: "detached-tick",
        contextId: "detached-cron",
        expression: "globalThis.next()",
      },
    });
    yield* boxes.action(input.sandboxId, {
      op: "cron.schedule",
      id: "detached-stale-once",
      schedule: new Date(due).toISOString(),
      overlap: "allow",
      execution: {
        op: "process.run",
        language: "javascript",
        id: "detached-stale-tick",
        contextId: "detached-stale",
        source:
          "export default async({tools})=>tools.call({op:'filesystem.writeFile',path:'/detached-stale-entered',content:'bad',encoding:'utf8'})",
      },
    });
    yield* boxes.action(input.sandboxId, { op: "contexts.reset", id: "detached-stale" });
    return yield* Schema.decodeUnknownEffect(QueuedBindingCreated)({
      phase: "create",
      callbacks: callbacks.count,
      queued,
      schedule,
    });
  }
  const schedule = yield* boxes
    .action(input.sandboxId, { op: "cron.get", id: "detached-once" })
    .pipe(
      Effect.repeat({
        until: (job) => job.state !== "active",
        times: 90,
        schedule: Schedule.spaced("1 second"),
      }),
    );
  if (schedule.lastProcessId === null)
    return yield* Effect.die({
      message: "Native cron has not admitted the retained occurrence",
      schedule,
    });
  const queued = yield* Effect.forEach(["detached-queued-js", "detached-queued-python"], (id) =>
    boxes.action(input.sandboxId, { op: "process.wait", id, timeoutMs: 25000 }),
  );
  const scheduledProcess = yield* boxes.action(input.sandboxId, {
    op: "process.wait",
    id: schedule.lastProcessId,
    timeoutMs: 25000,
  });
  const continued = [
    yield* boxes.action(input.sandboxId, {
      op: "javascript.evaluate",
      id: "detached-next-js",
      contextId: "detached-js",
      expression: "globalThis.next()",
    }),
    yield* boxes.action(input.sandboxId, {
      op: "python.evaluate",
      id: "detached-next-python",
      contextId: "detached-python",
      expression: "next_value()",
    }),
  ];
  const staleSchedule = yield* boxes
    .action(input.sandboxId, { op: "cron.get", id: "detached-stale-once" })
    .pipe(
      Effect.repeat({
        until: (job) => job.state !== "active",
        times: 5,
        schedule: Schedule.spaced("1 second"),
      }),
    );
  const staleContext = yield* boxes.action(input.sandboxId, {
    op: "contexts.get",
    id: "detached-stale",
  });
  const exists = yield* boxes.action(input.sandboxId, {
    op: "filesystem.exists",
    path: "/detached-stale-entered",
  });
  return yield* Schema.decodeUnknownEffect(QueuedBindingVerified)({
    phase: "verify",
    queued,
    continued,
    schedule,
    scheduledProcess,
    staleSchedule,
    staleContext,
    staleFileExists: exists.exists,
  });
});
