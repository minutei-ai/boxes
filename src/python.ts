import { Cause, Clock, Effect, Schema } from "effect";
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
  FilesystemAction,
  ActionResponses,
  PythonProgram,
  RunResult,
  ToolStep,
} from "./contracts";
import { guestAction } from "./capabilities";
import { PythonFileAction, pythonFile } from "./python-files";
import type { OutputCapture } from "./output";
import type { Env } from "./resources";
import type { open } from "./storage";

const PythonFilesystemRequest = Schema.fromJsonString(
  Schema.Union([FilesystemAction, PythonFileAction]),
);

class PythonFailure extends Schema.TaggedError<PythonFailure>()("PythonFailure", {
  cause: Schema.Unknown,
  fuelRemaining: Schema.optionalKey(Schema.String),
  memoryBytes: Schema.optionalKey(Schema.Int),
  resourceTrap: Schema.optionalKey(Schema.Int),
}) {
  get message() {
    return `Python native failure (resourceTrap=${this.resourceTrap}, fuelRemaining=${this.fuelRemaining}, memoryBytes=${this.memoryBytes})\n${Cause.pretty(Cause.fail(this.cause))}`;
  }
}
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
  const bridge = {
    stack: 0,
    request: new Uint8Array(0),
    response: new Uint8Array(0),
    rejected: false,
  };
  const native = yield* Effect.try({
    try: () => {
      const bindings = createBindings({
        request(pointer, length) {
          if (state.asyncify_get_state() === 2) {
            state.asyncify_stop_rewind();
            if (bridge.rejected) return -bridge.response.byteLength;
            return bridge.response.byteLength;
          }
          if (bridge.stack === 0 || length > 1_048_576) return 0;
          bridge.request = new Uint8Array(state.memory.buffer, pointer, length).slice();
          state.asyncify_start_unwind(bridge.stack);
          return 0;
        },
        response(pointer, length) {
          if (
            length !== bridge.response.byteLength ||
            pointer + length > state.memory.buffer.byteLength
          )
            return -1;
          new Uint8Array(state.memory.buffer, pointer, length).set(bridge.response);
          bridge.response = new Uint8Array(0);
          return 0;
        },
      });
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
  bridge.stack = yield* Effect.try({
    try: () => native.bindings.io_stack(),
    catch: (cause) => new PythonFailure({ cause }),
  });
  const retained = yield* Effect.acquireRelease(
    Effect.try({
      try: () => {
        if (context !== null && context.record.heap !== null)
          return {
            guest: native.bindings.PythonGuest.resume(context.record.heap.handle),
            released: false,
          };
        const guest = new native.bindings.PythonGuest(
          program.source,
          program.filePath,
          program.mode === "evaluate",
          policy.maxOutputBytes,
          Schema.encodeSync(Schema.fromJsonString(Environment))(program.env),
        );
        guest.enable_filesystem();
        return {
          guest,
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
    const polling = {
      status: yield* Effect.try({
        try: () => resource.poll(),
        catch: (cause) =>
          new PythonFailure({
            cause,
            fuelRemaining: String(native.state.__cirro_fuel.value),
            memoryBytes: native.state.memory.buffer.byteLength,
            resourceTrap: Number(native.state.__cirro_trap_reason.value),
          }),
      }),
    };
    while (
      yield* Effect.try({
        try: () => native.state.asyncify_get_state() === 1,
        catch: (cause) => new PythonFailure({ cause }),
      })
    ) {
      yield* Effect.try({
        try: () => native.state.asyncify_stop_unwind(),
        catch: (cause) => new PythonFailure({ cause }),
      });
      const calledAt = yield* Clock.currentTimeMillis;
      if (capability.expiresAt <= calledAt)
        return yield* new Fault({
          code: "UNAUTHORIZED",
          status: 401,
          message: "Capability expired",
        });
      if (context !== null && calledAt >= context.record.deadlineAt)
        return yield* new Fault({
          code: "ETIMEDOUT",
          status: 408,
          message: "Python context authority expired",
        });
      if (budget.requests >= 256)
        return yield* new PythonFailure({ cause: "Python host request budget exceeded" });
      budget.requests += 1;
      const encoded = yield* Effect.try({
        try: () => new TextDecoder("utf-8", { fatal: true }).decode(bridge.request),
        catch: (cause) => new PythonFailure({ cause }),
      });
      const action = yield* Schema.decodeUnknownEffect(PythonFilesystemRequest, {
        onExcessProperty: "error",
      })(encoded);
      bridge.request = new Uint8Array(0);
      const response = yield* Effect.gen(function* () {
        if (
          action.op === "python.file.openRead" ||
          action.op === "python.file.read" ||
          action.op === "python.file.stat"
        )
          return yield* pythonFile(env, capability, action);
        const result = yield* guestAction(env, capability, action);
        return new TextEncoder().encode(
          Schema.encodeUnknownSync(Schema.fromJsonString(ActionResponses[action.op]))(result),
        );
      }).pipe(Effect.result);
      if (response._tag === "Success") {
        bridge.response = response.success;
        bridge.rejected = false;
      } else {
        if (response.failure._tag !== "Fault") return yield* response.failure;
        bridge.response = new TextEncoder().encode(
          Schema.encodeSync(Schema.fromJsonString(ErrorResponse))({
            error: response.failure.code,
            message: response.failure.message,
          }),
        );
        bridge.rejected = true;
      }
      if (bridge.response.byteLength > 25_165_824)
        return yield* new PythonFailure({ cause: "Python filesystem response exceeds its bound" });
      const resumedAt = yield* Clock.currentTimeMillis;
      if (capability.expiresAt <= resumedAt)
        return yield* new Fault({
          code: "UNAUTHORIZED",
          status: 401,
          message: "Capability expired",
        });
      if (context !== null && resumedAt >= context.record.deadlineAt)
        return yield* new Fault({
          code: "ETIMEDOUT",
          status: 408,
          message: "Python context authority expired",
        });
      polling.status = yield* Effect.try({
        try: () => {
          native.state.asyncify_start_rewind(bridge.stack);
          return resource.poll();
        },
        catch: (cause) =>
          new PythonFailure({
            cause,
            fuelRemaining: String(native.state.__cirro_fuel.value),
            memoryBytes: native.state.memory.buffer.byteLength,
            resourceTrap: Number(native.state.__cirro_trap_reason.value),
          }),
      });
    }
    if (polling.status !== 1)
      return yield* new PythonFailure({ cause: "Python poll did not publish a step" });
    const raw = yield* Effect.try({
      try: () => resource.take_step(),
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
