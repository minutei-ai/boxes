import { Effect, Result, Schema } from "effect";
import guestWasm from "cirro:guest";
import { initSync, Guest, run_wasm } from "../dist/guest/cirro_guest";
import {
  Capability,
  Fault,
  GuestAction,
  GuestResponse,
  Policy,
  Program,
  ScriptProgram,
  ErrorResponse,
  RunResult,
  ModuleRequest,
  ModuleBatch,
} from "./contracts";
import { guestAction } from "./capabilities";
import { dynamic } from "./modules";
import type { Env } from "./resources";

initSync({ module: guestWasm });

class InterpreterFailure extends Schema.TaggedError<InterpreterFailure>()("InterpreterFailure", {
  cause: Schema.Unknown,
}) {}
const Step = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("request"), action: Schema.fromJsonString(GuestAction) }),
  Schema.Struct({ kind: Schema.Literal("done"), output: Schema.fromJsonString(RunResult) }),
  ModuleRequest.mapFields((fields) => ({ kind: Schema.Literal("module"), ...fields })),
]);

export const execute = Effect.fn("execution.run")(function* (
  env: Env,
  capability: typeof Capability.Type,
  program: typeof Program.Type,
  policy: typeof Policy.Type,
) {
  if (program.language === "python")
    return yield* new Fault({
      code: "UNSUPPORTED_RUNTIME",
      status: 501,
      message:
        "Python requires a bounded interpreter inside the standard Worker; Dynamic Workers are disabled",
    });
  if (program.language === "wasm") {
    const result = yield* Effect.try({
      try: () =>
        run_wasm(
          Buffer.from(program.source, "base64"),
          policy.memoryBytes,
          BigInt(policy.interruptBudget) * 1000n,
        ),
      catch: (cause) => new InterpreterFailure({ cause }),
    });
    return {
      outcome: Result.succeed({ stdout: "", stderr: "", result, exitCode: 0 }),
      program,
      changed: false,
    };
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
