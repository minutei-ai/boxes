import { makeAgentBinding } from "./sdk-rpc";
import type { AgentProtocol } from "./rpc-protocol";
import { AgentRequest, HostCall, Id, Policy, ReclamationProgress } from "./contracts";
import type { IsolateConfig, ExecutionResult } from "@tanstack/ai-code-mode";
import { Cause, Effect, Exit, Match, Option, Redacted, Schema, Scope, Semaphore } from "effect";

export class BoxesContextCleanupError extends Schema.TaggedError<BoxesContextCleanupError>()(
  "BoxesContextCleanupError",
  { sandboxId: Id, progress: ReclamationProgress },
) {}

const BindingName = HostCall.fields.name.check(Schema.isPattern(/^external_[a-zA-Z0-9_$]+$/));
const ReturnedValue = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("undefined") }),
  Schema.Struct({ kind: Schema.Literal("value"), value: Schema.Json }),
]);

export const BoxesIsolateTarget = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("ephemeral"),
    administratorToken: Schema.Redacted(AgentRequest.fields.token),
  }),
  Schema.Struct({
    kind: Schema.Literal("persistent"),
    sandboxId: Id,
    contextId: AgentRequest.fields.contextId,
    capabilityToken: Schema.Redacted(AgentRequest.fields.token),
  }),
]);

export const createBoxesIsolateDriver = (
  binding: Fetcher<AgentProtocol>,
  target: typeof BoxesIsolateTarget.Type,
) => ({
  createContext: (configuration: IsolateConfig & { readonly abortSignal?: AbortSignal }) => {
    configuration.abortSignal?.throwIfAborted();
    return Effect.runPromise(
      Effect.gen(function* () {
        const credential = Match.value(target).pipe(
          Match.when({ kind: "ephemeral" }, (target) => target.administratorToken),
          Match.when({ kind: "persistent" }, (target) => target.capabilityToken),
          Match.exhaustive,
        );
        const control = yield* makeAgentBinding(binding, credential);
        const id = Match.value(target).pipe(
          Match.when({ kind: "persistent" }, (target) => target.sandboxId),
          Match.orElse(() => `context-${crypto.randomUUID()}`),
        );
        const contextId = Match.value(target).pipe(
          Match.when({ kind: "persistent" }, (target) => target.contextId),
          Match.orElse(() => undefined),
        );
        const memoryBytes = yield* Schema.decodeUnknownEffect(Policy.fields.memoryBytes)(
          (configuration.memoryLimit ?? 16) * 1048576,
        );
        const names = yield* Schema.decodeUnknownEffect(Schema.Array(BindingName))(
          Object.keys(configuration.bindings),
        );
        const scope = yield* Scope.make();
        const state = { closed: false, reclaimed: false };
        const closing = yield* Semaphore.make(1);
        const close = Effect.fn("boxes.context.dispose")(function* (
          exit: Exit.Exit<unknown, unknown>,
        ) {
          state.closed = true;
          yield* Scope.close(scope, exit).pipe(
            Effect.ensuring(
              Effect.gen(function* () {
                if (target.kind === "persistent" || state.reclaimed) return;
                const grant = yield* control
                  .mintCapability(id, {
                    permissions: ["manage"],
                    expiresInSeconds: 600,
                  })
                  .pipe(
                    Effect.asSome,
                    Effect.catchTag("BoxesError", (failure) => {
                      if (failure.status === 404 && failure.error === "ENOENT")
                        return Effect.succeed(Option.none());
                      return Effect.fail(failure);
                    }),
                  );
                if (Option.isNone(grant)) return;
                const cleanup = yield* makeAgentBinding(binding, Redacted.make(grant.value.token));
                yield* cleanup.action(id, { op: "vm.dispose" });
                const progress = yield* cleanup
                  .action(id, { op: "vm.reclaim", limit: 1000 })
                  .pipe(
                    Effect.repeat({ until: (progress) => progress.status !== "pending" }),
                    Effect.interruptible,
                    Effect.timeout("60 seconds"),
                  );
                if (progress.status !== "complete")
                  return yield* new BoxesContextCleanupError({ sandboxId: id, progress });
                state.reclaimed = true;
              }).pipe(Effect.orDie),
            ),
          );
        }, closing.withPermit);
        const active = new Set<string>();
        const acquisition = Effect.gen(function* () {
          if (target.kind === "ephemeral")
            yield* control.create({
              id,
              policy: {
                networkHosts: [],
                interruptBudget: 1000,
                memoryBytes,
                maxOutputBytes: 1048576,
              },
            });
          yield* Effect.addFinalizer(() =>
            Effect.gen(function* () {
              state.closed = true;
              if (active.size === 0) return;
              const cleanup = yield* Effect.gen(function* () {
                if (target.kind === "persistent") return control;
                const grant = yield* control.mintCapability(id, {
                  permissions: ["read", "execute", "manage"],
                  expiresInSeconds: 60,
                });
                return yield* makeAgentBinding(binding, Redacted.make(grant.token));
              });
              yield* Effect.forEach(
                active,
                (runId) =>
                  cleanup.action(id, { op: "process.cancel", id: runId }).pipe(
                    Effect.andThen(() =>
                      cleanup.action(id, {
                        op: "process.wait",
                        id: runId,
                        timeoutMs: 25000,
                      }),
                    ),
                    Effect.catchTag("BoxesError", (failure) => {
                      if (
                        failure.error === "ENOENT" ||
                        failure.error === "ECANCELED" ||
                        failure.error === "EXECUTION_FAILED"
                      )
                        return Effect.void;
                      return Effect.fail(failure);
                    }),
                  ),
                { concurrency: 3 },
              );
            }).pipe(Effect.orDie),
          );
          if (target.kind === "persistent") {
            if (contextId !== undefined) {
              yield* control.action(id, { op: "contexts.get", id: contextId });
              return control;
            }
            yield* control.action(id, { op: "vm.status" });
            return control;
          }
          const grant = yield* control.mintCapability(id, {
            permissions: ["read", "write", "execute", "manage"],
            expiresInSeconds: 600,
          });
          return yield* makeAgentBinding(binding, Redacted.make(grant.token));
        }).pipe(Effect.provideService(Scope.Scope, scope));
        const boxes = yield* acquisition.pipe(
          Effect.onError((cause) => close(Exit.failCause(cause))),
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
                const input = yield* Effect.sync(() => {
                  const request = {
                    id: runId,
                    source,
                    tools: names,
                    maxToolCalls: 256,
                    timeoutMs: configuration.timeout ?? 30000,
                    memoryBytes,
                  };
                  if (contextId === undefined) return request;
                  return { ...request, contextId };
                });
                const execution = boxes.runWithTools(id, input, (call) =>
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
                  record.status === "exited" ||
                  record.status === "failed" ||
                  record.status === "cancelled"
                )
                  active.delete(runId);
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
          dispose: () => Effect.runPromise(close(Exit.void)),
        };
      }),
    );
  },
});
