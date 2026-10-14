import { Effect, Result, Schema } from "effect";
import guestWasm from "cirro:guest";
import { initSync, Guest } from "../dist/guest/cirro_guest";
import {
  Capability,
  CapturedStdio,
  GuestResponse,
  Program,
  ScriptProgram,
  ErrorResponse,
  RunResult,
  ModuleRequest,
  ModuleBatch,
  ToolStep,
  Fault,
  HostCall,
} from "./contracts";
import type { HostBridge } from "./host";
import { guestAction } from "./capabilities";
import { dynamic } from "./modules";
import { wasi } from "./wasi";
import { python } from "./python";
import type { open } from "./storage";
import type { OutputCapture } from "./output";
import type { Env } from "./resources";

initSync({ module: guestWasm });

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
) {
  const policy = session.head.policy;
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
    ).pipe(Effect.result);
    return { outcome, program, changed: false };
  }
  if (!("modules" in program))
    return yield* new InterpreterFailure({ cause: "This program belongs to another runtime" });
  const guest = yield* Effect.acquireRelease(
    Effect.try({
      try: () =>
        new Guest(
          Schema.encodeSync(Schema.fromJsonString(ScriptProgram))(program),
          policy.memoryBytes,
          policy.interruptBudget,
          policy.maxOutputBytes,
        ),
      catch: (cause) => new InterpreterFailure({ cause }),
    }),
    (guest) => Effect.sync(() => guest.free()),
  );
  const outcome = yield* Effect.gen(function* () {
    const completed: (typeof RunResult.Type)[] = [];
    while (completed.length === 0) {
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
              if (response._tag === "Success")
                return guest.respond(
                  Schema.encodeSync(Schema.fromJsonString(Schema.Json))(response.success),
                  false,
                );
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
          const value = Schema.encodeUnknownSync(Schema.fromJsonString(GuestResponse))(
            response.success,
          );
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
  return { outcome, program: captured, changed: guest.revision() > 0 };
});
