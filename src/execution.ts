import { Effect, Schema } from "effect";
import guestWasm from "cirro:guest";
import compilerWasm from "cirro:compiler";
import { initSync, Guest, run_wasm } from "../dist/guest/cirro_guest";
import { initSync as initCompiler, transpile } from "../dist/compiler/cirro_compiler";
import {
  Capability,
  Fault,
  GuestAction,
  GuestResponse,
  Policy,
  RunAction,
  RunResult,
} from "./contracts";
import { guestAction } from "./capabilities";
import type { Env } from "./resources";

initSync({ module: guestWasm });
initCompiler({ module: compilerWasm });

class InterpreterFailure extends Schema.TaggedError<InterpreterFailure>()("InterpreterFailure", {
  cause: Schema.Unknown,
}) {}
const Step = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("request"), action: Schema.fromJsonString(GuestAction) }),
  Schema.Struct({ kind: Schema.Literal("done"), output: Schema.fromJsonString(RunResult) }),
]);

export const execute = Effect.fn("execution.run")(function* (
  env: Env,
  capability: typeof Capability.Type,
  action: typeof RunAction.Type,
  policy: typeof Policy.Type,
) {
  if (action.language === "python")
    return yield* new Fault({
      code: "UNSUPPORTED_RUNTIME",
      status: 501,
      message:
        "Python requires a bounded interpreter inside the standard Worker; Dynamic Workers are disabled",
    });
  if (action.language === "wasm") {
    const result = yield* Effect.try({
      try: () =>
        run_wasm(
          Buffer.from(action.source, "base64"),
          policy.memoryBytes,
          BigInt(policy.interruptBudget) * 1000n,
        ),
      catch: (cause) => new InterpreterFailure({ cause }),
    });
    return { stdout: "", stderr: "", result, exitCode: 0 };
  }
  const source = yield* Effect.try({
    try: () => {
      if (action.language === "typescript") return transpile(action.source);
      return action.source;
    },
    catch: (cause) => new InterpreterFailure({ cause }),
  });
  const guest = yield* Effect.acquireRelease(
    Effect.try({
      try: () =>
        new Guest(source, policy.memoryBytes, policy.interruptBudget, policy.maxOutputBytes),
      catch: (cause) => new InterpreterFailure({ cause }),
    }),
    (guest) => Effect.sync(() => guest.free()),
  );
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
          try: () => guest.respond("Capability operation failed", true),
          catch: (cause) => new InterpreterFailure({ cause }),
        });
      }
    }
  }
  const result = completed[0];
  if (result === undefined)
    return yield* new InterpreterFailure({ cause: "Missing execution result" });
  return result;
});
