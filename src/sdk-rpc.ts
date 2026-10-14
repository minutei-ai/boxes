import { Effect, Redacted, Schema } from "effect";
import { AgentInput, AgentReply, AgentRequest } from "./contracts";
import { BoxesError, makeBinding } from "./sdk";
import type { AgentProtocol, HostCallback } from "./rpc-protocol";
export type { AgentProtocol, HostCallback } from "./rpc-protocol";

export class RpcFailure extends Schema.TaggedError<RpcFailure>()("RpcFailure", {
  cause: Schema.Unknown,
}) {}

export const makeAgentBinding = Effect.fn("boxes.agent.makeBinding")(function* (
  binding: Fetcher<AgentProtocol>,
  token: Redacted.Redacted<string>,
) {
  const client = yield* makeBinding(binding, token);
  return {
    ...client,
    runWithTools: Effect.fn("boxes.agent.runWithTools")(function* (
      sandboxId: string,
      input: typeof AgentInput.Type,
      callback: HostCallback,
    ) {
      const request = yield* Schema.encodeEffect(AgentRequest)({
        ...input,
        sandboxId,
        token: Redacted.value(token),
      });
      return yield* Effect.acquireUseRelease(
        Effect.tryPromise({
          try: async () => await binding.runWithTools(request, callback),
          catch: (cause) => new RpcFailure({ cause }),
        }),
        (record) =>
          Effect.gen(function* () {
            const reply = yield* Schema.decodeUnknownEffect(AgentReply)(record);
            if (!reply.ok)
              return yield* new BoxesError({
                status: reply.status,
                error: reply.error,
                message: reply.message,
              });
            return reply.record;
          }),
        (record) => Effect.sync(() => record[Symbol.dispose]()),
      );
    }),
  };
});
