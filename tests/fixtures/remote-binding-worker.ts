import { TerminalProof, TerminalProofInput, terminalProof } from "./terminal-proof";
import { DescriptorProof, descriptorProof } from "./descriptor-proof";
import { Cause, Clock, Effect, Redacted, Schedule, Schema } from "effect";
import { makeBinding } from "../../src/sdk";
import { makeAgentBinding } from "../../src/sdk-rpc";
import type { AgentProtocol } from "../../src/rpc-protocol";
import type { HostCall } from "../../src/contracts";
import { persistentBindingProof } from "./remote-persistent-binding";
import { publishedInterpreterFile, publishedInterpreterCases } from "./published-software";
import { shellCwdProof } from "./shell-cwd-proof";
import {
  PublishedTerminalInput,
  PublishedTerminalProof,
  publishedTerminalProof,
  TerminalObservationFailure,
} from "./published-terminal-proof";

import {
  RemoteBindingInput,
  RemoteBindingProof,
  remoteRpcTimeoutMs,
  remoteDeadlinePath,
} from "./remote-binding-contracts";

export default {
  fetch(request: Request, env: { BOXES: Fetcher; BOXES_AGENT: Fetcher<AgentProtocol> }) {
    return Effect.runPromise(
      Effect.gen(function* () {
        if (new URL(request.url).pathname === "/published-terminal") {
          const input = yield* Schema.decodeUnknownEffect(
            Schema.fromJsonString(PublishedTerminalInput),
            { onExcessProperty: "error" },
          )(yield* Effect.promise(() => request.text()));
          const client = yield* makeBinding(env.BOXES, Redacted.make(input.token));
          const proof = yield* publishedTerminalProof(client, input.sandboxId, input.backend);
          return new Response(
            Schema.encodeSync(Schema.fromJsonString(PublishedTerminalProof))(proof),
            { headers: { "content-type": "application/json", "cache-control": "no-store" } },
          );
        }
        if (new URL(request.url).pathname === "/persistent")
          return yield* persistentBindingProof(request, env.BOXES_AGENT);
        if (new URL(request.url).pathname === "/terminal") {
          const input = yield* Schema.decodeUnknownEffect(
            Schema.fromJsonString(TerminalProofInput),
            { onExcessProperty: "error" },
          )(yield* Effect.promise(() => request.text()));
          const client = yield* makeBinding(env.BOXES, Redacted.make(input.token));
          const proof = yield* terminalProof(
            client,
            input.sandboxId,
            input.source,
            input.foregroundSource,
            input.rawOwners,
            input.attributeSources,
          );
          return new Response(Schema.encodeSync(Schema.fromJsonString(TerminalProof))(proof), {
            headers: { "content-type": "application/json", "cache-control": "no-store" },
          });
        }
        const input = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(RemoteBindingInput), {
          onExcessProperty: "error",
        })(yield* Effect.promise(() => request.text()));
        const token = Redacted.make(input.token);
        const client = yield* makeBinding(env.BOXES, token);
        if (new URL(request.url).pathname === "/descriptors") {
          const proof = yield* descriptorProof(client, input.sandboxId);
          return new Response(Schema.encodeSync(Schema.fromJsonString(DescriptorProof))(proof), {
            headers: { "content-type": "application/json", "cache-control": "no-store" },
          });
        }
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
            timeoutMs: remoteRpcTimeoutMs,
          },
          async (call) => {
            calls.push(call);
            const observed = await Effect.runPromise(
              client
                .action(input.sandboxId, { op: "filesystem.readFile", path: remoteDeadlinePath })
                .pipe(
                  Effect.retry({
                    schedule: Schedule.spaced("100 millis"),
                    while: (failure) => failure._tag === "BoxesError" && failure.status === 404,
                  }),
                  Effect.timeout("10 seconds"),
                ),
            );
            if (observed.content !== Buffer.from("observed").toString("base64"))
              return { ok: false, message: "Inline deadline observation was not acknowledged" };
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
            timeoutMs: remoteRpcTimeoutMs,
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
              timeoutMs: remoteRpcTimeoutMs,
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
        yield* client.action(input.sandboxId, {
          op: "filesystem.writeFile",
          ...publishedInterpreterFile,
        });
        yield* client.action(input.sandboxId, {
          op: "filesystem.chmod",
          path: publishedInterpreterFile.path,
          mode: 493,
        });
        const interpreters = yield* Effect.forEach(publishedInterpreterCases, (probe) =>
          client.action(input.sandboxId, {
            op: "process.execFile",
            id: probe.id,
            command: probe.command,
            args: probe.args,
            env: { CIRRO_MARKER: probe.id },
            stdin: { content: "input line\n", encoding: "utf8" },
          }),
        );
        const interpreterFile = yield* client.action(input.sandboxId, {
          op: "filesystem.readFile",
          path: "/tmp/from-script",
        });
        const shellCwd = yield* shellCwdProof(client, input.sandboxId, "sh", "/opt/cirro/bin/sh");
        return new Response(
          Schema.encodeSync(Schema.fromJsonString(RemoteBindingProof))({
            measuredAt: yield* Clock.currentTimeMillis,
            callback,
            voidCallback,
            interpreters,
            interpreterFile,
            shellCwd,
            file,
            calls,
            managementDenied: denied.failure.status,
            wrongSandboxDenied: wrong.failure.status,
          }),
          { headers: { "content-type": "application/json", "cache-control": "no-store" } },
        );
      }).pipe(
        Effect.catchTag("TerminalObservationFailure", (failure) =>
          Effect.succeed(
            new Response(
              Schema.encodeSync(Schema.fromJsonString(TerminalObservationFailure))(failure),
              {
                status: 500,
                headers: { "content-type": "application/json", "cache-control": "no-store" },
              },
            ),
          ),
        ),
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
