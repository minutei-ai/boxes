import { Effect, Redacted, Schema, Struct } from "effect";
import { makeAgentBinding } from "../../src/sdk-rpc";
import { createBoxesIsolateDriver } from "../../src/sdk-tanstack";
import { AgentRequest, ContextRecord, RunRecord } from "../../src/contracts";
import type { AgentProtocol } from "../../src/rpc-protocol";

export const RetainedBindingInput = Schema.Struct({
  ...AgentRequest.mapFields((fields) => Struct.pick(fields, ["sandboxId", "token"])).fields,
  phase: Schema.Literals(["create", "resume"]),
});
export const RetainedBindingProof = Schema.Struct({
  phase: RetainedBindingInput.fields.phase,
  context: ContextRecord,
  records: Schema.Array(RunRecord),
  callbacks: Schema.Int,
  deleted: Schema.Boolean,
  driver: Schema.Struct({ value: Schema.Json, closedDenied: Schema.Boolean }),
});
export const VerifiedRetainedBindingProof = RetainedBindingProof.check(
  Schema.makeFilter((proof) => {
    if (
      !proof.driver.closedDenied ||
      proof.callbacks !== 1 ||
      proof.context.state !== "idle" ||
      proof.records.some((record) => record.status !== "exited" || record.output?.exitCode !== 0)
    )
      return false;
    if (proof.phase === "create")
      return (
        proof.driver.value === 41 &&
        !proof.deleted &&
        proof.context.generation === 0 &&
        proof.records.length === 2 &&
        Schema.is(Schema.Struct({ counter: Schema.Literal(41), tool: Schema.Literal(11) }))(
          proof.records[1]?.output?.result,
        )
      );
    return (
      proof.driver.value === 42 &&
      proof.deleted &&
      proof.context.generation === 1 &&
      proof.records.length === 3 &&
      Schema.is(Schema.Struct({ counter: Schema.Literal(42), tool: Schema.Literal(42) }))(
        proof.records[0]?.output?.result,
      ) &&
      proof.records[0]?.output?.stdout === "resumed\n" &&
      proof.records[1]?.output?.result === "FORBIDDEN" &&
      proof.records[2]?.output?.result === "undefined"
    );
  }),
);

export const retainedBindingProof = Effect.fn("fixture.retainedBindingProof")(function* (
  request: Request,
  binding: Fetcher<AgentProtocol>,
) {
  const input = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(RetainedBindingInput), {
    onExcessProperty: "error",
  })(yield* Effect.promise(() => request.text()));
  const client = yield* makeAgentBinding(binding, Redacted.make(input.token));
  const callbacks = { count: 0 };
  if (input.phase === "create")
    yield* client.action(input.sandboxId, { op: "contexts.create", id: "retained-driver" });
  const isolate = createBoxesIsolateDriver(binding, {
    kind: "persistent",
    sandboxId: input.sandboxId,
    capabilityToken: Redacted.make(input.token),
    contextId: "retained-driver",
  });
  const driver = yield* Effect.scoped(
    Effect.gen(function* () {
      const context = yield* Effect.acquireRelease(
        Effect.tryPromise(() =>
          isolate.createContext({ memoryLimit: 8, timeout: 30000, bindings: {} }),
        ),
        (context) => Effect.promise(() => context.dispose()),
      );
      const code = yield* Effect.sync(() => {
        if (input.phase === "create")
          return "let n=40;globalThis.driverNext=()=>++n;return globalThis.driverNext();";
        return "return globalThis.driverNext();";
      });
      const result = yield* Effect.tryPromise(() => context.execute(code));
      if (!result.success) return yield* Effect.die(result);
      const value = yield* Schema.decodeUnknownEffect(Schema.Json)(result.value);
      yield* Effect.promise(() => context.dispose());
      const closed = yield* Effect.tryPromise(() => context.execute("return 0;"));
      return { value, closedDenied: !closed.success };
    }),
  );
  if (input.phase === "create") {
    yield* client.action(input.sandboxId, { op: "contexts.create", id: "retained" });
    const seed = yield* client.action(input.sandboxId, {
      op: "javascript.execute",
      contextId: "retained",
      id: "retained-seed",
      source: "let n=40;globalThis.next=()=>++n;globalThis.log=console.log;",
    });
    const record = yield* client.runWithTools(
      input.sandboxId,
      {
        contextId: "retained",
        id: "retained-first",
        tools: ["lookup"],
        maxToolCalls: 1,
        timeoutMs: 30000,
        source:
          "export default async({tools})=>{globalThis.savedTool=()=>tools.call({op:'host.call',name:'lookup'});return{counter:globalThis.next(),tool:await globalThis.savedTool()};}",
      },
      async () => {
        callbacks.count += 1;
        return { ok: true, value: 11 };
      },
    );
    return yield* Schema.decodeUnknownEffect(VerifiedRetainedBindingProof)({
      phase: input.phase,
      records: [seed, record],
      context: yield* client.action(input.sandboxId, { op: "contexts.get", id: "retained" }),
      callbacks: callbacks.count,
      deleted: false,
      driver,
    });
  }
  const record = yield* client.runWithTools(
    input.sandboxId,
    {
      contextId: "retained",
      id: "retained-next",
      tools: ["lookup"],
      maxToolCalls: 1,
      timeoutMs: 30000,
      source:
        "export default async()=>{globalThis.log('resumed');return{counter:globalThis.next(),tool:await globalThis.savedTool()};}",
    },
    async () => {
      callbacks.count += 1;
      return { ok: true, value: 42 };
    },
  );
  const denied = yield* client.runWithTools(
    input.sandboxId,
    {
      contextId: "retained",
      id: "retained-denied",
      tools: [],
      maxToolCalls: 1,
      timeoutMs: 30000,
      source: "export default()=>globalThis.savedTool().catch(error=>error.code);",
    },
    async () => {
      callbacks.count += 1;
      return { ok: true, value: "forbidden" };
    },
  );
  yield* client.action(input.sandboxId, { op: "contexts.reset", id: "retained" });
  const cleared = yield* client.action(input.sandboxId, {
    op: "javascript.evaluate",
    contextId: "retained",
    id: "retained-cleared",
    expression: "typeof globalThis.next",
  });
  const context = yield* client.action(input.sandboxId, { op: "contexts.get", id: "retained" });
  const deleted = yield* client.action(input.sandboxId, { op: "contexts.delete", id: "retained" });
  return yield* Schema.decodeUnknownEffect(VerifiedRetainedBindingProof)({
    phase: input.phase,
    records: [record, denied, cleared],
    context,
    callbacks: callbacks.count,
    deleted: deleted.ok,
    driver,
  });
});
