import { Clock, Effect, Schema } from "effect";
import wasm from "cirro:python";
import revision from "../dist/python/revision.json";
import { acquireContext, finishContext } from "./contexts";
import { restoreMemoryPages, saveMemoryPages } from "./memory";
import { createBindings } from "../dist/python/bindings";
import {
  Capability,
  checkpointPageLimit,
  Environment,
  CapturedStdio,
  ErrorResponse,
  Fault,
  ActionResponses,
  PythonProgram,
  RunResult,
  ToolStep,
} from "./contracts";
import { guestAction } from "./capabilities";
import type { OutputCapture } from "./output";
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
  capture: OutputCapture | null,
  context: Effect.Success<ReturnType<typeof acquireContext>> | null,
) {
  const policy = session.head.policy;
  const started = yield* Clock.currentTimeMillis;
  if (capability.expiresAt <= started)
    return yield* new Fault({ code: "UNAUTHORIZED", status: 401, message: "Capability expired" });
  const native = yield* Effect.try({
    try: () => {
      const bindings = createBindings();
      const state = bindings.initSync({ module: wasm });
      const requested = Math.floor((state.memory.buffer.byteLength + policy.memoryBytes) / 65_536);
      const pages = Math.min(requested, checkpointPageLimit);
      if (context === null) {
        state.__cirro_limits(100_000_000n, requested);
        return { bindings, state, pages: requested };
      }
      state.__cirro_limits(100_000_000n, pages);
      return { bindings, state, pages };
    },
    catch: (cause) => new PythonFailure({ cause }),
  });
  if (context !== null && context.record.heap !== null) {
    if (
      context.record.heap.runtime !== revision.sha256 ||
      context.record.heap.memoryLimitBytes !== policy.memoryBytes ||
      context.record.heap.maxOutputBytes !== policy.maxOutputBytes ||
      context.record.heap.memoryBytes > native.pages * 65536
    )
      return yield* new Fault({
        code: "CONTEXT_LIMITS_CHANGED",
        status: 409,
        message: "Python context runtime or limits changed before entry",
      });
    yield* restoreMemoryPages(
      env.OBJECTS,
      capability.sandboxId,
      native.state.memory,
      context.record.heap,
    );
  }
  const retained = yield* Effect.acquireRelease(
    Effect.try({
      try: () => {
        if (context !== null && context.record.heap !== null)
          return {
            guest: native.bindings.PythonGuest.resume(context.record.heap.handle),
            released: false,
          };
        return {
          guest: new native.bindings.PythonGuest(
            program.source,
            program.filePath,
            program.mode === "evaluate",
            policy.maxOutputBytes,
            Schema.encodeSync(Schema.fromJsonString(Environment))(program.env),
          ),
          released: false,
        };
      },
      catch: (cause) => new PythonFailure({ cause }),
    }),
    (resource) =>
      Effect.sync(() => {
        if (!resource.released) resource.guest.free();
      }),
  );
  const resource = retained.guest;
  yield* Effect.try({
    try: () => native.state.__cirro_limits(BigInt(policy.interruptBudget) * 1000n, native.pages),
    catch: (cause) => new PythonFailure({ cause }),
  });
  if (context !== null && context.record.heap !== null) {
    context.entered = true;
    yield* Effect.try({
      try: () =>
        resource.begin(
          program.source,
          program.filePath,
          program.mode === "evaluate",
          Schema.encodeSync(Schema.fromJsonString(Environment))(program.env),
        ),
      catch: (cause) => new PythonFailure({ cause }),
    });
  }
  const completed: (typeof RunResult.Type)[] = [];
  const budget = { requests: 0 };
  while (completed.length === 0) {
    const now = yield* Clock.currentTimeMillis;
    if (capability.expiresAt <= now)
      return yield* new Fault({ code: "UNAUTHORIZED", status: 401, message: "Capability expired" });
    if (context !== null) {
      if (now >= context.record.deadlineAt)
        return yield* new Fault({
          code: "ETIMEDOUT",
          status: 408,
          message: "Python context authority expired",
        });
      context.entered = true;
    }
    const raw = yield* Effect.try({
      try: () => resource.step(),
      catch: (cause) => new PythonFailure({ cause }),
    });
    const step = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(ToolStep), {
      onExcessProperty: "error",
    })(raw);
    if (capture !== null && step.kind !== "done") {
      const rawStdio = yield* Effect.try({
        try: () => resource.stdio(),
        catch: (cause) => new PythonFailure({ cause }),
      });
      const stdio = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(CapturedStdio))(
        rawStdio,
      );
      yield* capture(stdio);
    }
    const authorizedAt = yield* Clock.currentTimeMillis;
    if (capability.expiresAt <= authorizedAt)
      return yield* new Fault({ code: "UNAUTHORIZED", status: 401, message: "Capability expired" });
    if (context !== null && authorizedAt >= context.record.deadlineAt)
      return yield* new Fault({
        code: "ETIMEDOUT",
        status: 408,
        message: "Python context authority expired",
      });
    if (step.kind === "done") {
      completed.push(step.output);
      continue;
    }
    if (budget.requests >= 256)
      return yield* new PythonFailure({ cause: "Python host request budget exceeded" });
    budget.requests += 1;
    const response = yield* guestAction(env, capability, step.action).pipe(Effect.result);
    if (response._tag === "Success") {
      const value = Schema.encodeUnknownSync(
        Schema.fromJsonString(ActionResponses[step.action.op]),
      )(response.success);
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
  if (context !== null) {
    if (!resource.quiescent())
      return yield* new PythonFailure({ cause: "Retained Python execution did not settle" });
    retained.released = true;
    const handle = yield* Effect.try({
      try: () => resource.park(),
      catch: (cause) => new PythonFailure({ cause }),
    });
    const saved = yield* saveMemoryPages(
      env.OBJECTS,
      capability.sandboxId,
      native.state.memory,
      context.record.heap?.pages,
    );
    yield* finishContext(env, capability, context, {
      runtime: revision.sha256,
      codec: saved.codec,
      memoryBytes: saved.memoryBytes,
      pages: saved.pages,
      handle,
      memoryLimitBytes: policy.memoryBytes,
      maxOutputBytes: policy.maxOutputBytes,
    });
  }
  return completed[0];
});
