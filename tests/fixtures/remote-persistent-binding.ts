import { Effect, Redacted, Schema, Struct } from "effect";
import { createBoxesIsolateDriver } from "../../src/sdk-tanstack";
import { AgentRequest, FileContent } from "../../src/contracts";
import type { AgentProtocol } from "../../src/rpc-protocol";

export const PersistentBindingInput = Schema.Struct({
  ...AgentRequest.mapFields((fields) => Struct.pick(fields, ["sandboxId", "token"])).fields,
  phase: Schema.Literals(["create", "resume"]),
});
const Value = Schema.Struct({
  content: FileContent.fields.content,
  encoding: FileContent.fields.encoding,
  freshGlobals: Schema.Literal(true),
  label: PersistentBindingInput.fields.phase,
});
export const PersistentBindingProof = Schema.Struct({
  phase: PersistentBindingInput.fields.phase,
  value: Value,
  callbacks: Schema.Array(PersistentBindingInput.fields.phase),
  closedContextDenied: Schema.Boolean,
  writeDenied: Schema.NullOr(Schema.Boolean),
  lowMemoryDenied: Schema.Boolean,
  policyMemoryDenied: Schema.Boolean,
  allowedAllocation: Schema.Int,
});
export const VerifiedPersistentBindingProof = PersistentBindingProof.check(
  Schema.makeFilter((proof) => {
    if (
      proof.value.label !== proof.phase ||
      Buffer.from(proof.value.content, proof.value.encoding).toString() !==
        "persistent native binding" ||
      proof.callbacks.length !== 1 ||
      proof.callbacks[0] !== proof.phase ||
      !proof.closedContextDenied ||
      !proof.lowMemoryDenied ||
      !proof.policyMemoryDenied ||
      proof.allowedAllocation !== 6000000
    )
      return false;
    if (proof.phase === "create") return proof.writeDenied === null;
    return proof.writeDenied === true;
  }),
);
export const persistentBindingProof = Effect.fn("fixture.persistentBindingProof")(function* (
  request: Request,
  binding: Fetcher<AgentProtocol>,
) {
  const input = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(PersistentBindingInput), {
    onExcessProperty: "error",
  })(yield* Effect.promise(() => request.text()));
  const driver = createBoxesIsolateDriver(binding, {
    kind: "persistent",
    sandboxId: input.sandboxId,
    capabilityToken: Redacted.make(input.token),
  });
  const callbacks: (typeof PersistentBindingInput.fields.phase.Type)[] = [];
  const context = yield* Effect.acquireRelease(
    Effect.tryPromise(() =>
      driver.createContext({
        memoryLimit: 4,
        timeout: 15000,
        bindings: {
          external_label: {
            name: "label",
            description: "Identify this consumer context",
            inputSchema: {},
            execute: async () => {
              callbacks.push(input.phase);
              return input.phase;
            },
          },
        },
      }),
    ),
    (context) => Effect.promise(() => context.dispose()),
  );
  if (input.phase === "create") {
    const written = yield* Effect.tryPromise(() =>
      context.execute(
        'globalThis.previousTurn = true; await tools.call({op:"filesystem.writeFile",path:"/persistent.txt",content:"persistent native binding",encoding:"utf8"});',
      ),
    );
    if (!written.success) return yield* Effect.die(written);
  }
  const observed = yield* Effect.tryPromise(() =>
    context.execute(
      'const label = await external_label(); const file = await tools.call({op:"filesystem.readFile",path:"/persistent.txt"}); return {...file,freshGlobals:typeof globalThis.previousTurn === "undefined",label};',
    ),
  );
  if (!observed.success) return yield* Effect.die(observed);
  const value = yield* Schema.decodeUnknownEffect(Value)(observed.value);
  const writeDenied = yield* Effect.gen(function* () {
    if (input.phase === "create") return null;
    const write = yield* Effect.tryPromise(() =>
      context.execute(
        'await tools.call({op:"filesystem.writeFile",path:"/persistent.txt",content:"unauthorized",encoding:"utf8"});',
      ),
    );
    return !write.success;
  });
  const lowMemory = yield* Effect.tryPromise(() =>
    context.execute("return new Uint8Array(6000000).length;"),
  );
  yield* Effect.promise(() => context.dispose());
  const closed = yield* Effect.tryPromise(() => context.execute("return external_label();"));
  const policyMemory = yield* Effect.acquireUseRelease(
    Effect.tryPromise(() =>
      driver.createContext({ memoryLimit: 32, timeout: 15000, bindings: {} }),
    ),
    (context) =>
      Effect.gen(function* () {
        const allowed = yield* Effect.tryPromise(() =>
          context.execute("return new Uint8Array(6000000).length;"),
        );
        if (!allowed.success) return yield* Effect.die(allowed);
        const allocation = yield* Schema.decodeUnknownEffect(Schema.Int)(allowed.value);
        const denied = yield* Effect.tryPromise(() =>
          context.execute("return new Uint8Array(20000000).length;"),
        );
        return { allocation, denied };
      }),
    (context) => Effect.promise(() => context.dispose()),
  );
  return new Response(
    Schema.encodeSync(Schema.fromJsonString(PersistentBindingProof))({
      phase: input.phase,
      value,
      callbacks,
      closedContextDenied: !closed.success && closed.error?.name === "AbortError",
      writeDenied,
      lowMemoryDenied: !lowMemory.success,
      policyMemoryDenied: !policyMemory.denied.success,
      allowedAllocation: policyMemory.allocation,
    }),
    { headers: { "content-type": "application/json", "cache-control": "no-store" } },
  );
}, Effect.scoped);
