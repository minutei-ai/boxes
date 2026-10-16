import { Clock, Effect, Result, Schema } from "effect";
import guestWasm from "cirro:guest";
import { createBindings } from "../dist/guest/bindings";
import revision from "../dist/guest/revision.json";
import { acquireContext, finishContext } from "./contexts";
import { saveMemoryPages, restoreMemoryPages } from "./memory";
import {
  Capability,
  Policy,
  CapturedStdio,
  ActionResponses,
  Program,
  ScriptProgram,
  ErrorResponse,
  RunResult,
  ModuleRequest,
  ModuleBatch,
  ToolStep,
  Fault,
  HostCall,
  StoredRun,
} from "./contracts";
import type { HostBridge } from "./host";
import { guestAction } from "./capabilities";
import { dynamic } from "./modules";
import { wasi } from "./wasi";
import { python } from "./python";
import type { open } from "./storage";
import type { OutputCapture } from "./output";
import type { Env } from "./resources";

const bindings = createBindings();
bindings.initSync({ module: guestWasm });

class InterpreterFailure extends Schema.TaggedError<InterpreterFailure>()("InterpreterFailure", {
  cause: Schema.Unknown,
}) {}
const Step = Schema.Union([
  ToolStep,
  Schema.Struct({ kind: Schema.Literal("request"), action: Schema.fromJsonString(HostCall) }),
  ModuleRequest.mapFields((fields) => ({ kind: Schema.Literal("module"), ...fields })),
]);

export const execute = Effect.fn("execution.run")(function* (
  env: Env,
  capability: typeof Capability.Type,
  program: typeof Program.Type,
  session: Effect.Success<ReturnType<typeof open>>,
  capture: OutputCapture | null,
  inputId: string | null,
  checkpoint: string | null,
  canHandover: boolean,
  host: HostBridge | null = null,
  memoryLimitBytes: typeof Policy.Type.memoryBytes | null = null,
  stdinMode: typeof StoredRun.Type.inputMode = "closed",
  context: Effect.Success<ReturnType<typeof acquireContext>> | null = null,
) {
  const policy = session.head.policy;
  if (
    memoryLimitBytes !== null &&
    program.language !== "javascript" &&
    program.language !== "typescript"
  )
    return yield* new InterpreterFailure({
      cause: "Per-execution memory limits require a JavaScript or TypeScript program",
    });
  if (program.language === "python")
    return {
      outcome: yield* python(env, capability, program, session, capture).pipe(Effect.result),
      program,
      changed: false,
    };
  if (program.language === "wasm") {
    const outcome = yield* wasi(
      env,
      capability,
      program,
      session,
      capture,
      inputId,
      checkpoint,
      canHandover,
      stdinMode,
    ).pipe(Effect.result);
    return { outcome, program, changed: false };
  }
  if (!("modules" in program))
    return yield* new InterpreterFailure({ cause: "This program belongs to another runtime" });
  const isolated = yield* Effect.gen(function* () {
    if (context === null) return null;
    const factory = createBindings();
    const native = factory.initSync({ module: guestWasm });
    if (context.record.heap !== null) {
      if (
        context.record.heap.runtime !== revision.sha256 ||
        context.record.heap.memoryLimitBytes !==
          Math.min(policy.memoryBytes, memoryLimitBytes ?? policy.memoryBytes) ||
        context.record.heap.maxOutputBytes !== policy.maxOutputBytes
      )
        return yield* new Fault({
          code: "CONTEXT_LIMITS_CHANGED",
          status: 409,
          message: "Context runtime or limits changed before program entry",
        });
      yield* restoreMemoryPages(
        env.OBJECTS,
        capability.sandboxId,
        native.memory,
        context.record.heap,
      );
    }
    return { bindings: factory, memory: native.memory };
  });
  const retained = yield* Effect.acquireRelease(
    Effect.try({
      try: () => {
        if (isolated !== null && context !== null && context.record.heap !== null)
          return {
            guest: isolated.bindings.Guest.resume(context.record.heap.handle),
            released: false,
          };
        const factory = isolated?.bindings ?? bindings;
        return {
          guest: new factory.Guest(
            Schema.encodeSync(Schema.fromJsonString(ScriptProgram))(program),
            Math.min(policy.memoryBytes, memoryLimitBytes ?? policy.memoryBytes),
            policy.interruptBudget,
            policy.maxOutputBytes,
          ),
          released: false,
        };
      },
      catch: (cause) => new InterpreterFailure({ cause }),
    }),
    (retained) =>
      Effect.sync(() => {
        if (!retained.released) retained.guest.free();
      }),
  );
  const guest = retained.guest;
  if (context !== null && context.record.heap !== null)
    yield* Effect.try({
      try: () =>
        guest.begin(
          Schema.encodeSync(Schema.fromJsonString(ScriptProgram))(program),
          policy.interruptBudget,
        ),
      catch: (cause) => new InterpreterFailure({ cause }),
    });
  const outcome = yield* Effect.gen(function* () {
    const completed: (typeof RunResult.Type)[] = [];
    while (completed.length === 0) {
      if (context !== null) {
        const now = yield* Clock.currentTimeMillis;
        if (now >= capability.expiresAt || now >= context.record.deadlineAt)
          return yield* new Fault({
            code: "ETIMEDOUT",
            status: 408,
            message: "Context execution authority expired",
          });
        context.entered = true;
      }
      const raw = yield* Effect.try({
        try: () => guest.step(),
        catch: (cause) => new InterpreterFailure({ cause }),
      });
      const step = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Step), {
        onExcessProperty: "error",
      })(raw);
      if (capture !== null && step.kind !== "done") {
        const rawStdio = yield* Effect.try({
          try: () => guest.stdio(),
          catch: (cause) => new InterpreterFailure({ cause }),
        });
        const stdio = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(CapturedStdio))(
          rawStdio,
        );
        yield* capture(stdio);
      }
      if (step.kind === "done") {
        completed.push(step.output);
      } else if (step.kind === "module") {
        const response = yield* Effect.scoped(dynamic(env, capability, step)).pipe(Effect.result);
        if (response._tag === "Success") {
          yield* Effect.try({
            try: () =>
              guest.respond_module(
                Schema.encodeSync(Schema.fromJsonString(ModuleBatch))(response.success),
              ),
            catch: (cause) => new InterpreterFailure({ cause }),
          });
        } else {
          yield* Effect.try({
            try: () => {
              if (response.failure._tag === "Fault")
                return guest.respond(
                  Schema.encodeSync(Schema.fromJsonString(ErrorResponse))({
                    error: response.failure.code,
                    message: response.failure.message,
                  }),
                  true,
                );
              return guest.respond(
                Schema.encodeSync(Schema.fromJsonString(ErrorResponse))({
                  error: "INTERNAL",
                  message: "Module loading failed",
                }),
                true,
              );
            },
            catch: (cause) => new InterpreterFailure({ cause }),
          });
        }
      } else {
        if (step.action.op === "host.call") {
          const call = step.action;
          const response = yield* Effect.gen(function* () {
            if (host === null)
              return yield* new Fault({
                code: "FORBIDDEN",
                status: 403,
                message: "Host callbacks require an active RPC execution",
              });
            return yield* host(call);
          }).pipe(Effect.result);
          yield* Effect.try({
            try: () => {
              if (response._tag === "Success") {
                if (response.success === undefined) return guest.respond_undefined();
                return guest.respond(
                  Schema.encodeSync(Schema.fromJsonString(Schema.Json))(response.success),
                  false,
                );
              }
              if (response.failure._tag === "Fault")
                return guest.respond(
                  Schema.encodeSync(Schema.fromJsonString(ErrorResponse))({
                    error: response.failure.code,
                    message: response.failure.message,
                  }),
                  true,
                );
              return guest.respond(
                Schema.encodeSync(Schema.fromJsonString(ErrorResponse))({
                  error: "HOST_CALLBACK_FAILED",
                  message: "Host callback transport failed",
                }),
                true,
              );
            },
            catch: (cause) => new InterpreterFailure({ cause }),
          });
          continue;
        }
        const response = yield* guestAction(env, capability, step.action).pipe(Effect.result);
        if (response._tag === "Success") {
          const value = Schema.encodeUnknownSync(
            Schema.fromJsonString(ActionResponses[step.action.op]),
          )(response.success);
          yield* Effect.try({
            try: () => guest.respond(value, false),
            catch: (cause) => new InterpreterFailure({ cause }),
          });
        } else {
          yield* Effect.try({
            try: () => {
              if (response.failure._tag === "Fault")
                return guest.respond(
                  Schema.encodeSync(Schema.fromJsonString(ErrorResponse))({
                    error: response.failure.code,
                    message: response.failure.message,
                  }),
                  true,
                );
              return guest.respond(
                Schema.encodeSync(Schema.fromJsonString(ErrorResponse))({
                  error: "INTERNAL",
                  message: "Capability operation failed",
                }),
                true,
              );
            },
            catch: (cause) => new InterpreterFailure({ cause }),
          });
        }
      }
    }
    const result = completed[0];
    if (result === undefined)
      return yield* new InterpreterFailure({ cause: "Missing execution result" });
    return result;
  }).pipe(Effect.result);
  const captured = yield* Effect.try({
    try: () => guest.program(),
    catch: (cause) => new InterpreterFailure({ cause }),
  }).pipe(Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(ScriptProgram))));
  const changed = guest.revision() > 0;
  if (context !== null && isolated !== null && outcome._tag === "Success") {
    if (!guest.quiescent())
      return yield* new InterpreterFailure({
        cause: "Retained execution left pending work; reset the context",
      });
    retained.released = true;
    const handle = yield* Effect.try({
      try: () => guest.park(),
      catch: (cause) => new InterpreterFailure({ cause }),
    });
    const saved = yield* saveMemoryPages(
      env.OBJECTS,
      capability.sandboxId,
      isolated.memory,
      context.record.heap?.pages ?? [],
    );
    yield* finishContext(env, capability, context, {
      runtime: revision.sha256,
      memoryBytes: saved.memoryBytes,
      pages: saved.pages,
      handle,
      memoryLimitBytes: Math.min(policy.memoryBytes, memoryLimitBytes ?? policy.memoryBytes),
      maxOutputBytes: policy.maxOutputBytes,
    });
  }
  return { outcome, program: captured, changed };
});
