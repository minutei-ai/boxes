import { Cause, Clock, Effect, Redacted, Schema, Struct } from "effect";
import { makeBinding } from "../../src/sdk";
import { makeAgentBinding } from "../../src/sdk-rpc";
import type { AgentProtocol } from "../../src/rpc-protocol";
import { AgentRequest, FileContent, HostCall, RunRecord } from "../../src/contracts";
import { persistentBindingProof } from "./remote-persistent-binding";

export const RemoteBindingInput = AgentRequest.mapFields((fields) =>
  Struct.pick(fields, ["sandboxId", "token"]),
);
export const RemoteBindingProof = Schema.Struct({
  measuredAt: Schema.Int,
  callback: RunRecord,
  voidCallback: RunRecord,
  file: FileContent,
  calls: Schema.Array(HostCall),
  managementDenied: Schema.Int,
  wrongSandboxDenied: Schema.Int,
});
const CallbackValue = Schema.Struct({
  answer: Schema.Literal(42),
  transport: Schema.Literal("native RPC"),
});
const VoidValue = Schema.Struct({
  wasUndefined: Schema.Literal(true),
  freshGlobals: Schema.Literal(true),
});
export const VerifiedRemoteBindingProof = RemoteBindingProof.check(
  Schema.makeFilter(
    (proof) =>
      proof.callback.status === "exited" &&
      proof.callback.output?.exitCode === 0 &&
      Schema.is(CallbackValue)(proof.callback.output.result) &&
      proof.voidCallback.status === "exited" &&
      proof.voidCallback.output?.exitCode === 0 &&
      Schema.is(VoidValue)(proof.voidCallback.output.result),
  ),
  Schema.makeFilter(
    (proof) =>
      proof.managementDenied === 403 &&
      proof.wrongSandboxDenied === 401 &&
      Buffer.from(proof.file.content, proof.file.encoding).toString() ===
        "native Cloudflare binding" &&
      proof.calls.length === 2 &&
      proof.calls[0]?.name === "answer" &&
      Schema.is(Schema.Struct({ value: Schema.Literal(21) }))(proof.calls[0]?.input) &&
      proof.calls[1]?.name === "void" &&
      proof.calls[1]?.input === undefined,
  ),
);
export default {
  fetch(request: Request, env: { BOXES: Fetcher; BOXES_AGENT: Fetcher<AgentProtocol> }) {
    return Effect.runPromise(
      Effect.gen(function* () {
        if (new URL(request.url).pathname === "/persistent")
          return yield* persistentBindingProof(request, env.BOXES_AGENT);
        const input = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(RemoteBindingInput), {
          onExcessProperty: "error",
        })(yield* Effect.promise(() => request.text()));
        const token = Redacted.make(input.token);
        const client = yield* makeBinding(env.BOXES, token);
        const agent = yield* makeAgentBinding(env.BOXES_AGENT, token);
        const calls: (typeof HostCall.Type)[] = [];
        yield* client.action(input.sandboxId, {
          op: "filesystem.writeFile",
          path: "/binding.txt",
          content: "native Cloudflare binding",
          encoding: "utf8",
        });
        const callback = yield* agent.runWithTools(
          input.sandboxId,
          {
            id: "rpc-callback",
            source:
              'export default async ({ tools }) => { globalThis.probe = 1; const reply = await tools.call({ op: "host.call", name: "answer", input: { value: 21 } }); return reply; }',
            tools: ["answer"],
            maxToolCalls: 1,
            timeoutMs: 15000,
          },
          async (call) => {
            calls.push(call);
            return { ok: true, value: { answer: 42, transport: "native RPC" } };
          },
        );
        const voidCallback = yield* agent.runWithTools(
          input.sandboxId,
          {
            id: "rpc-void",
            source:
              'export default async ({ tools }) => { const reply = await tools.call({ op: "host.call", name: "void" }); return { wasUndefined: reply === undefined, freshGlobals: typeof globalThis.probe === "undefined" }; }',
            tools: ["void"],
            maxToolCalls: 1,
            timeoutMs: 15000,
          },
          async (call) => {
            calls.push(call);
            return { ok: true };
          },
        );
        const denied = yield* client
          .action(input.sandboxId, { op: "vm.dispose" })
          .pipe(Effect.result);
        if (denied._tag !== "Failure" || denied.failure._tag !== "BoxesError")
          return yield* Effect.die("Management request did not fail with a declared error");
        const wrong = yield* agent
          .runWithTools(
            `${input.sandboxId}-foreign`,
            {
              id: "wrong-sandbox",
              source: "export default () => 42",
              tools: [],
              maxToolCalls: 1,
              timeoutMs: 15000,
            },
            async () => {
              return { ok: true };
            },
          )
          .pipe(Effect.result);
        if (wrong._tag !== "Failure" || wrong.failure._tag !== "BoxesError")
          return yield* Effect.die("Foreign sandbox request did not fail with a declared error");
        const file = yield* client.action(input.sandboxId, {
          op: "filesystem.readFile",
          path: "/binding.txt",
        });
        return new Response(
          Schema.encodeSync(Schema.fromJsonString(RemoteBindingProof))({
            measuredAt: yield* Clock.currentTimeMillis,
            callback,
            voidCallback,
            file,
            calls,
            managementDenied: denied.failure.status,
            wrongSandboxDenied: wrong.failure.status,
          }),
          { headers: { "content-type": "application/json", "cache-control": "no-store" } },
        );
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.succeed(
            new Response(Cause.pretty(cause), {
              status: 500,
              headers: { "content-type": "text/plain", "cache-control": "no-store" },
            }),
          ),
        ),
      ),
    );
  },
};
