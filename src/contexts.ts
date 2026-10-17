import { Clock, Effect, Schema, Struct } from "effect";
import revision from "../dist/guest/revision.json";
import pythonRevision from "../dist/python/revision.json";
import { requirePermission } from "./auth";
import {
  Capability,
  ContextAction,
  ContextRecord,
  ContextReference,
  RunAction,
  PythonAction,
  ScriptAction,
  ContextHeap,
  ContextMetadata,
  Fault,
  Policy,
  StoredContext,
} from "./contracts";
import { head, StorageFailure } from "./storage";
import type { Env } from "./resources";

export const contextLanguage = (action: typeof RunAction.Type) => {
  if (Schema.is(PythonAction)(action)) return "python" as const;
  if (Schema.is(ScriptAction)(action)) return "javascript" as const;
  return null;
};

export const referenceContext = Effect.fn("contexts.reference")(function* (
  env: Env,
  capability: typeof Capability.Type,
  action: typeof RunAction.Type,
  expected: typeof ContextReference.Type | null = null,
) {
  if (!("contextId" in action) || action.contextId === undefined) {
    if (expected !== null)
      return yield* new Fault({
        code: "CONTEXT_STALE",
        status: 409,
        message: "Execution lost its context identity",
      });
    return null;
  }
  yield* requirePermission(capability, "execute");
  const language = contextLanguage(action);
  if (language === null)
    return yield* new Fault({
      code: "UNSUPPORTED_RUNTIME",
      status: 501,
      message: "Execution cannot retain a language context",
    });
  const record = yield* getContext(env, capability, action.contextId);
  if (record.language !== language)
    return yield* new Fault({
      code: "CONTEXT_LANGUAGE_MISMATCH",
      status: 409,
      message: "Execution language does not match its context",
    });
  if (record.state === "failed")
    return yield* new Fault({
      code: "CONTEXT_FAILED",
      status: 409,
      message: "Reset the failed context before enqueueing work",
    });
  if (expected !== null && (record.id !== expected.id || record.generation !== expected.generation))
    return yield* new Fault({
      code: "CONTEXT_STALE",
      status: 409,
      message: "Execution belongs to another context generation",
    });
  return Struct.pick(record, ["id", "generation"]);
});

const readContext = Effect.fn("contexts.read")(function* (env: Env, sandboxId: string, id: string) {
  const object = yield* Effect.tryPromise({
    try: () => env.OBJECTS.get(`sandboxes/${sandboxId}/contexts/${id}.json`),
    catch: (cause) => new StorageFailure({ cause }),
  });
  if (object === null) return null;
  if (object.size > 131_072)
    return yield* new StorageFailure({ cause: "Oversized context record" });
  const record = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(StoredContext), {
    onExcessProperty: "error",
  })(
    yield* Effect.tryPromise({
      try: () => object.text(),
      catch: (cause) => new StorageFailure({ cause }),
    }),
  ).pipe(Effect.mapError((cause) => new StorageFailure({ cause })));
  if (record.id !== id) return yield* new StorageFailure({ cause: "Context identity mismatch" });
  return { record, etag: object.etag };
});

export const createContext = Effect.fn("contexts.create")(function* (
  env: Env,
  capability: typeof Capability.Type,
  id: string,
  language: typeof ContextRecord.Type.language,
) {
  yield* requirePermission(capability, "execute");
  yield* head(env, capability.sandboxId);
  const previous = yield* readContext(env, capability.sandboxId, id);
  if (previous !== null && previous.record.state !== "deleted")
    return yield* new Fault({ code: "EEXIST", status: 409, message: "Context already exists" });
  const now = yield* Clock.currentTimeMillis;
  const generation = (previous?.record.generation ?? -1) + 1;
  if (!Number.isSafeInteger(generation))
    return yield* new Fault({
      code: "EOVERFLOW",
      status: 409,
      message: "Context generation exhausted",
    });
  const record = {
    id,
    language,
    generation,
    state: "idle" as const,
    createdAt: now,
    updatedAt: now,
    executionId: null,
    deadlineAt: null,
    heap: null,
    claimId: null,
  };
  const condition = yield* Effect.sync(() => {
    if (previous === null) return { etagDoesNotMatch: "*" };
    return { etagMatches: previous.etag };
  });
  const saved = yield* Effect.tryPromise({
    try: () =>
      env.OBJECTS.put(
        `sandboxes/${capability.sandboxId}/contexts/${id}.json`,
        Schema.encodeSync(Schema.fromJsonString(StoredContext))(record),
        {
          onlyIf: condition,
          customMetadata: Schema.encodeSync(ContextMetadata)({
            summary: Struct.omit(record, ["heap", "claimId"]),
          }),
        },
      ),
    catch: (cause) => new StorageFailure({ cause }),
  });
  if (saved === null)
    return yield* new Fault({
      code: "CONFLICT",
      status: 409,
      message: "Context changed during creation",
    });
  return Struct.omit(record, ["heap", "claimId"]);
});

export const getContext = Effect.fn("contexts.get")(function* (
  env: Env,
  capability: typeof Capability.Type,
  id: string,
) {
  yield* requirePermission(capability, "read");
  yield* head(env, capability.sandboxId);
  const current = yield* readContext(env, capability.sandboxId, id);
  if (current === null || current.record.state === "deleted")
    return yield* new Fault({ code: "ENOENT", status: 404, message: "Context does not exist" });
  return Struct.omit(current.record, ["heap", "claimId"]);
});

export const listContexts = Effect.fn("contexts.list")(function* (
  env: Env,
  capability: typeof Capability.Type,
  action: Extract<typeof ContextAction.Type, { op: "contexts.list" }>,
) {
  yield* requirePermission(capability, "read");
  yield* head(env, capability.sandboxId);
  const page = yield* Effect.tryPromise({
    try: () =>
      env.OBJECTS.list({
        prefix: `sandboxes/${capability.sandboxId}/contexts/`,
        limit: action.limit,
        cursor: action.cursor,
        include: ["customMetadata"],
      }),
    catch: (cause) => new StorageFailure({ cause }),
  });
  const records = yield* Effect.forEach(page.objects, (object) =>
    Schema.decodeUnknownEffect(ContextMetadata)(object.customMetadata).pipe(
      Effect.map((value) => value.summary),
      Effect.mapError((cause) => new StorageFailure({ cause })),
    ),
  );
  const cursor = yield* Effect.sync(() => {
    if (page.truncated) return page.cursor;
    return null;
  });
  return { contexts: records.filter((record) => record.state !== "deleted"), cursor };
});

export const changeContext = Effect.fn("contexts.change")(function* (
  env: Env,
  capability: typeof Capability.Type,
  action: Extract<typeof ContextAction.Type, { op: "contexts.reset" | "contexts.delete" }>,
) {
  const id = action.id;
  yield* requirePermission(capability, "execute");
  yield* head(env, capability.sandboxId);
  const current = yield* readContext(env, capability.sandboxId, id);
  if (current === null || current.record.state === "deleted")
    return yield* new Fault({ code: "ENOENT", status: 404, message: "Context does not exist" });
  const now = yield* Clock.currentTimeMillis;
  if (
    current.record.state === "running" &&
    current.record.deadlineAt !== null &&
    current.record.deadlineAt > now
  )
    return yield* new Fault({
      code: "CONTEXT_BUSY",
      status: 409,
      message: "Context execution is still active",
    });
  const generation = current.record.generation + 1;
  if (!Number.isSafeInteger(generation))
    return yield* new Fault({
      code: "EOVERFLOW",
      status: 409,
      message: "Context generation exhausted",
    });
  const state = yield* Effect.sync(() => {
    if (action.op === "contexts.delete") return "deleted" as const;
    return "idle" as const;
  });
  const record = {
    ...current.record,
    generation,
    state,
    updatedAt: now,
    executionId: null,
    deadlineAt: null,
    heap: null,
    claimId: null,
  };
  const saved = yield* Effect.tryPromise({
    try: () =>
      env.OBJECTS.put(
        `sandboxes/${capability.sandboxId}/contexts/${id}.json`,
        Schema.encodeSync(Schema.fromJsonString(StoredContext))(record),
        {
          onlyIf: { etagMatches: current.etag },
          customMetadata: Schema.encodeSync(ContextMetadata)({
            summary: Struct.omit(record, ["heap", "claimId"]),
          }),
        },
      ),
    catch: (cause) => new StorageFailure({ cause }),
  });
  if (saved === null)
    return yield* new Fault({
      code: "CONFLICT",
      status: 409,
      message: "Context changed during lifecycle mutation",
    });
  return Struct.omit(record, ["heap", "claimId"]);
});

export const acquireContext = Effect.fn("contexts.acquire")(function* (
  env: Env,
  capability: typeof Capability.Type,
  id: string,
  executionId: string,
  deadlineAt: number,
  memoryLimitBytes: typeof Policy.Type.memoryBytes | null,
  language: typeof ContextRecord.Type.language,
  expectedGeneration: typeof ContextReference.Type.generation | null = null,
) {
  yield* requirePermission(capability, "read");
  yield* requirePermission(capability, "execute");
  const sandbox = yield* head(env, capability.sandboxId);
  const current = yield* readContext(env, capability.sandboxId, id);
  if (current === null || current.record.state === "deleted")
    return yield* new Fault({ code: "ENOENT", status: 404, message: "Context does not exist" });
  if (expectedGeneration !== null && current.record.generation !== expectedGeneration)
    return yield* new Fault({
      code: "CONTEXT_STALE",
      status: 409,
      message: "Execution belongs to another context generation",
    });
  if (current.record.language !== language)
    return yield* new Fault({
      code: "CONTEXT_LANGUAGE_MISMATCH",
      status: 409,
      message: "Execution language does not match its context",
    });
  if (current.record.state === "running")
    return yield* new Fault({
      code: "CONTEXT_BUSY",
      status: 409,
      message: "Context is active; inspect it before resetting an expired execution",
    });
  if (current.record.state === "failed")
    return yield* new Fault({
      code: "CONTEXT_FAILED",
      status: 409,
      message: "Reset the failed context before executing again",
    });
  if (current.record.heap !== null) {
    if (
      current.record.heap.runtime !==
      { javascript: revision.sha256, python: pythonRevision.sha256 }[language]
    )
      return yield* new Fault({
        code: "CHECKPOINT_RUNTIME_MISMATCH",
        status: 409,
        message: "Reset context created by another Rust runtime",
      });
    if (
      current.record.heap.memoryLimitBytes !==
        Math.min(
          sandbox.head.policy.memoryBytes,
          memoryLimitBytes ?? sandbox.head.policy.memoryBytes,
        ) ||
      current.record.heap.maxOutputBytes !== sandbox.head.policy.maxOutputBytes
    )
      return yield* new Fault({
        code: "CONTEXT_LIMITS_CHANGED",
        status: 409,
        message: "Reset context before changing its memory or output ceiling",
      });
  }
  const now = yield* Clock.currentTimeMillis;
  if (capability.expiresAt <= now || deadlineAt <= now)
    return yield* new Fault({
      code: "UNAUTHORIZED",
      status: 401,
      message: "Context authority expired",
    });
  const claimId = yield* Effect.sync(() => crypto.randomUUID());
  const record = {
    ...current.record,
    claimId,
    state: "running" as const,
    executionId,
    deadlineAt: Math.min(deadlineAt, capability.expiresAt),
    updatedAt: now,
  };
  return yield* Effect.acquireRelease(
    Effect.gen(function* () {
      const saved = yield* Effect.tryPromise({
        try: () =>
          env.OBJECTS.put(
            `sandboxes/${capability.sandboxId}/contexts/${id}.json`,
            Schema.encodeSync(Schema.fromJsonString(StoredContext))(record),
            {
              onlyIf: { etagMatches: current.etag },
              customMetadata: Schema.encodeSync(ContextMetadata)({
                summary: Struct.omit(record, ["heap", "claimId"]),
              }),
            },
          ),
        catch: (cause) => new StorageFailure({ cause }),
      });
      if (saved === null)
        return yield* new Fault({
          code: "CONFLICT",
          status: 409,
          message: "Another execution acquired the context",
        });
      return {
        record,
        original: current.record,
        etag: saved.etag,
        entered: false,
        committed: false,
      };
    }),
    (lease) =>
      Effect.gen(function* () {
        if (lease.committed) return;
        const updatedAt = yield* Clock.currentTimeMillis;
        const restored = yield* Effect.sync(() => {
          if (!lease.entered) return { ...lease.original, updatedAt };
          return {
            ...lease.record,
            state: "failed" as const,
            claimId: null,
            deadlineAt: null,
            updatedAt,
          };
        });
        yield* Effect.tryPromise({
          try: () =>
            env.OBJECTS.put(
              `sandboxes/${capability.sandboxId}/contexts/${id}.json`,
              Schema.encodeSync(Schema.fromJsonString(StoredContext))(restored),
              {
                onlyIf: { etagMatches: lease.etag },
                customMetadata: Schema.encodeSync(ContextMetadata)({
                  summary: Struct.omit(restored, ["heap", "claimId"]),
                }),
              },
            ),
          catch: (cause) => new StorageFailure({ cause }),
        });
      }).pipe(Effect.orDie),
  );
});

export const finishContext = Effect.fn("contexts.finish")(function* (
  env: Env,
  capability: typeof Capability.Type,
  lease: Effect.Success<ReturnType<typeof acquireContext>>,
  heap: typeof ContextHeap.Type,
) {
  const now = yield* Clock.currentTimeMillis;
  if (capability.expiresAt <= now || lease.record.deadlineAt <= now)
    return yield* new Fault({
      code: "ETIMEDOUT",
      status: 408,
      message: "Context authority expired before state publication",
    });
  yield* head(env, capability.sandboxId);
  const record = {
    ...lease.record,
    state: "idle" as const,
    claimId: null,
    deadlineAt: null,
    updatedAt: now,
    heap,
  };
  const saved = yield* Effect.tryPromise({
    try: () =>
      env.OBJECTS.put(
        `sandboxes/${capability.sandboxId}/contexts/${record.id}.json`,
        Schema.encodeSync(Schema.fromJsonString(StoredContext))(record),
        {
          onlyIf: { etagMatches: lease.etag },
          customMetadata: Schema.encodeSync(ContextMetadata)({
            summary: Struct.omit(record, ["heap", "claimId"]),
          }),
        },
      ),
    catch: (cause) => new StorageFailure({ cause }),
  });
  if (saved === null)
    return yield* new Fault({
      code: "CONFLICT",
      status: 409,
      message: "Context ownership changed before publication",
    });
  lease.committed = true;
});
