import { makeAgentBinding } from "./sdk-rpc";
import type { AgentProtocol } from "./rpc-protocol";
import { HostCall } from "./contracts";
import type { IsolateConfig, ExecutionResult } from "@tanstack/ai-code-mode";
import { Cause, Effect, Exit, Redacted, Schema, Scope } from "effect";

const BindingName = HostCall.fields.name.check(Schema.isPattern(/^external_[a-zA-Z0-9_$]+$/));
const ReturnedValue = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("undefined") }),
  Schema.Struct({ kind: Schema.Literal("value"), value: Schema.Json }),
]);

export const createBoxesIsolateDriver = (
  binding: Fetcher<AgentProtocol>,
  token: Redacted.Redacted<string>,
) => ({
  createContext: (configuration: IsolateConfig & { readonly abortSignal?: AbortSignal }) => {
    configuration.abortSignal?.throwIfAborted();
    return Effect.runPromise(
      Effect.gen(function* () {
        const administrator = yield* makeAgentBinding(binding, token);
        const id = `context-${crypto.randomUUID()}`;
        const names = yield* Schema.decodeUnknownEffect(Schema.Array(BindingName))(
          Object.keys(configuration.bindings),
        );
        const scope = yield* Scope.make();
        const state = { closed: false };
        const active = new Set<string>();
        const acquisition = Effect.gen(function* () {
          yield* Effect.acquireRelease(
            administrator.create({
              id,
              policy: {
                networkHosts: [],
                interruptBudget: 1000,
                memoryBytes: (configuration.memoryLimit ?? 16) * 1048576,
                maxOutputBytes: 1048576,
              },
            }),
            () =>
              Effect.gen(function* () {
                state.closed = true;
                const grant = yield* administrator.mintCapability(id, {
                  permissions: ["read", "execute", "manage"],
                  expiresInSeconds: 60,
                });
                const cleanup = yield* makeAgentBinding(binding, Redacted.make(grant.token));
                yield* Effect.forEach(
                  active,
                  (runId) =>
                    cleanup.action(id, { op: "process.cancel", id: runId }).pipe(
                      Effect.catchTag("BoxesError", (failure) => {
                        if (failure.error === "ENOENT") return Effect.void;
                        return Effect.fail(failure);
                      }),
                    ),
                  { concurrency: 3 },
                ).pipe(
                  Effect.ensuring(cleanup.action(id, { op: "vm.dispose" }).pipe(Effect.orDie)),
                );
              }).pipe(Effect.orDie),
          );
          const grant = yield* administrator.mintCapability(id, {
            permissions: ["read", "write", "execute", "manage"],
            expiresInSeconds: 600,
          });
          return yield* makeAgentBinding(binding, Redacted.make(grant.token));
        }).pipe(Effect.provideService(Scope.Scope, scope));
        const boxes = yield* acquisition.pipe(
          Effect.onError((cause) => Scope.close(scope, Exit.failCause(cause))),
        );
        return {
          execute: (code: string): Promise<ExecutionResult> =>
            Effect.runPromise(
              Effect.gen(function* () {
                if (state.closed || configuration.abortSignal?.aborted)
                  return {
                    success: false,
                    error: {
                      name: "AbortError",
                      message: "Execução cancelada.",
                    },
                  };
                const runId = `run-${crypto.randomUUID()}`;
                active.add(runId);
                const declarations = names
                  .map(
                    (name) =>
                      `const ${name} = input => tools.call({ op: "host.call", name: ${Schema.encodeSync(Schema.fromJsonString(BindingName))(name)}, input });`,
                  )
                  .join("\n");
                const source = `export default async ({tools}) => { ${declarations}\nconst value = await (async () => { ${code}\n})(); if (value === undefined) return {kind:"undefined"}; return {kind:"value",value}; }`;
                const execution = boxes.runWithTools(
                  id,
                  {
                    id: runId,
                    source,
                    tools: names,
                    maxToolCalls: 256,
                    timeoutMs: configuration.timeout ?? 30000,
                  },
                  (call) =>
                    Effect.runPromise(
                      Effect.gen(function* () {
                        if (state.closed || configuration.abortSignal?.aborted)
                          return {
                            ok: false as const,
                            message: "Execução cancelada.",
                          };
                        const binding = configuration.bindings[call.name];
                        if (binding === undefined)
                          return {
                            ok: false as const,
                            message: "Ferramenta indisponível.",
                          };
                        const value = yield* Effect.tryPromise(() =>
                          binding.execute(call.input),
                        ).pipe(Effect.result);
                        if (value._tag === "Failure")
                          return {
                            ok: false as const,
                            message: Cause.pretty(Cause.fail(value.failure)),
                          };
                        const decoded = yield* Schema.decodeUnknownEffect(
                          Schema.UndefinedOr(Schema.Json),
                        )(value.success);
                        return { ok: true as const, value: decoded };
                      }),
                    ),
                );
                const outcome = yield* execution.pipe(
                  Effect.onInterrupt(() =>
                    boxes.action(id, { op: "process.cancel", id: runId }).pipe(
                      Effect.catchTag("BoxesError", (failure) => {
                        if (failure.error === "ENOENT") return Effect.void;
                        return Effect.fail(failure);
                      }),
                      Effect.orDie,
                    ),
                  ),
                  Effect.result,
                );
                active.delete(runId);
                if (outcome._tag === "Failure")
                  return {
                    success: false,
                    error: {
                      name: "BoxesError",
                      message: Cause.pretty(Cause.fail(outcome.failure)),
                    },
                  };
                const record = outcome.success;
                if (
                  record.status !== "exited" ||
                  record.output === null ||
                  record.output.exitCode !== 0
                )
                  return {
                    success: false,
                    error: {
                      name: "ExecutionError",
                      message: record.output?.stderr ?? "A execução não concluiu.",
                    },
                  };
                const value = yield* Schema.decodeUnknownEffect(ReturnedValue)(
                  record.output.result,
                );
                const logs = record.output.stdout.split("\n").filter((line) => line.length > 0);
                if (value.kind === "undefined") return { success: true, logs };
                return { success: true, value: value.value, logs };
              }),
              { signal: configuration.abortSignal },
            ).catch((cause: unknown) => {
              if (configuration.abortSignal?.aborted)
                return {
                  success: false,
                  error: { name: "AbortError", message: "Execution cancelled" },
                };
              return Promise.reject(cause);
            }),
          dispose: () => Effect.runPromise(Scope.close(scope, Exit.succeed(undefined))),
        };
      }),
    );
  },
});
