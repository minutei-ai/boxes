import { Clock, Effect, Schema } from "effect";
import wasm from "cirro:python";
import { createBindings } from "../dist/python/bindings";
import {
  Capability,
  ErrorResponse,
  Fault,
  GuestResponse,
  PythonProgram,
  RunResult,
  ToolStep,
} from "./contracts";
import { guestAction } from "./capabilities";
import type { Env } from "./resources";
import type { open } from "./storage";

class PythonFailure extends Schema.TaggedError<PythonFailure>()("PythonFailure", {
  cause: Schema.Unknown,
}) {}
export const python = Effect.fn("python.execute")(function* (
  env: Env,
  capability: typeof Capability.Type,
  program: typeof PythonProgram.Type,
  session: Effect.Success<ReturnType<typeof open>>,
) {
  const policy = session.head.policy;
  const started = yield* Clock.currentTimeMillis;
  if (capability.expiresAt <= started)
    return yield* new Fault({ code: "UNAUTHORIZED", status: 401, message: "Capability expired" });
  const resource = yield* Effect.acquireRelease(
    Effect.try({
      try: () => {
        const bindings = createBindings();
        const state = bindings.initSync({ module: wasm });
        const pages = Math.floor((state.memory.buffer.byteLength + policy.memoryBytes) / 65_536);
        state.__cirro_limits(100_000_000n, pages);
        const guest = new bindings.PythonGuest(
          program.source,
          program.filePath,
          program.mode === "evaluate",
          policy.maxOutputBytes,
        );
        state.__cirro_limits(BigInt(policy.interruptBudget) * 1000n, pages);
        return guest;
      },
      catch: (cause) => new PythonFailure({ cause }),
    }),
    (guest) =>
      Effect.sync(() => {
        guest.free();
      }),
  );
  const completed: (typeof RunResult.Type)[] = [];
  const budget = { requests: 0 };
  while (completed.length === 0) {
    const now = yield* Clock.currentTimeMillis;
    if (capability.expiresAt <= now)
      return yield* new Fault({ code: "UNAUTHORIZED", status: 401, message: "Capability expired" });
    const raw = yield* Effect.try({
      try: () => resource.step(),
      catch: (cause) => new PythonFailure({ cause }),
    });
    const step = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(ToolStep), {
      onExcessProperty: "error",
    })(raw);
    const authorizedAt = yield* Clock.currentTimeMillis;
    if (capability.expiresAt <= authorizedAt)
      return yield* new Fault({ code: "UNAUTHORIZED", status: 401, message: "Capability expired" });
    if (step.kind === "done") {
      completed.push(step.output);
      continue;
    }
    if (budget.requests >= 256)
      return yield* new PythonFailure({ cause: "Python host request budget exceeded" });
    budget.requests += 1;
    const response = yield* guestAction(env, capability, step.action).pipe(Effect.result);
    if (response._tag === "Success") {
      const value = Schema.encodeUnknownSync(Schema.fromJsonString(GuestResponse))(
        response.success,
      );
      yield* Effect.try({
        try: () => resource.respond(value, false),
        catch: (cause) => new PythonFailure({ cause }),
      });
    } else {
      if (response.failure._tag !== "Fault") return yield* response.failure;
      const value = Schema.encodeSync(Schema.fromJsonString(ErrorResponse))({
        error: response.failure.code,
        message: response.failure.message,
      });
      yield* Effect.try({
        try: () => resource.respond(value, true),
        catch: (cause) => new PythonFailure({ cause }),
      });
    }
  }
  return completed[0];
});
