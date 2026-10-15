import { Effect, Schema } from "effect";
import { Kernel } from "../dist/kernel/cirro_kernel";
import { requirePermission } from "./auth";
import { Capability, Fault, Head, ReclamationState, StoredRunMetadata } from "./contracts";
import { kernelCall, readHead, StorageFailure } from "./storage";
import type { Env } from "./resources";

export const reclaim = Effect.fn("sandbox.reclaim")(function* (
  env: Env,
  capability: typeof Capability.Type,
  limit: number,
) {
  yield* requirePermission(capability, "manage");
  const id = capability.sandboxId;
  const snapshot = yield* readHead(env, id);
  if (!snapshot.head.deleted)
    return yield* new Fault({
      code: "CONFLICT",
      status: 409,
      message: "Dispose the sandbox before reclaiming its data",
    });
  const key = `reclamations/${id}.json`;
  const stored = yield* Effect.tryPromise({
    try: () => env.OBJECTS.get(key),
    catch: (cause) => new StorageFailure({ cause }),
  });
  const state = yield* Effect.gen(function* () {
    if (stored === null) return { phase: "processes" as const };
    const body = yield* Effect.tryPromise({
      try: () => stored.text(),
      catch: (cause) => new StorageFailure({ cause }),
    });
    return yield* Schema.decodeUnknownEffect(Schema.fromJsonString(ReclamationState))(body).pipe(
      Effect.mapError((cause) => new StorageFailure({ cause })),
    );
  });
  const phase = yield* Effect.gen(function* () {
    if (state.phase === "complete") return "processes" as const;
    if (state.phase === "processes") return state.phase;
    const processes = yield* Effect.tryPromise({
      try: () => env.OBJECTS.list({ prefix: `processes/${id}/`, limit: 1 }),
      catch: (cause) => new StorageFailure({ cause }),
    });
    if (processes.objects.length === 0 && processes.truncated)
      return yield* new StorageFailure({ cause: "Incomplete reclamation process guard" });
    if (processes.objects.length === 0) return state.phase;
    return "processes" as const;
  });
  const prefixes = {
    processes: `processes/${id}/`,
    inputs: `process-input/${id}/`,
    schedules: `schedules/${id}/`,
    objects: `sandboxes/${id}/`,
  };
  const headKey = `sandboxes/${id}/head.json`;
  const page = yield* Effect.tryPromise({
    try: () => {
      const options = { prefix: prefixes[phase], limit: Math.min(1000, limit + 1) };
      if (phase === "processes")
        return env.OBJECTS.list({ ...options, include: ["customMetadata"] });
      return env.OBJECTS.list(options);
    },
    catch: (cause) => new StorageFailure({ cause }),
  });
  const targets = yield* Effect.gen(function* () {
    const filtered = page.objects.filter((object) => object.key !== headKey);
    if (filtered.length === 0 && page.truncated && phase !== "objects")
      return yield* new StorageFailure({ cause: "Empty truncated reclamation page" });
    if (filtered.length > 0 || !page.truncated || phase !== "objects")
      return filtered.slice(0, limit);
    const after = yield* Effect.tryPromise({
      try: () => env.OBJECTS.list({ prefix: prefixes[phase], cursor: page.cursor, limit }),
      catch: (cause) => new StorageFailure({ cause }),
    });
    const remaining = after.objects.filter((object) => object.key !== headKey);
    if (remaining.length === 0 && after.truncated)
      return yield* new StorageFailure({ cause: "Empty truncated reclamation continuation" });
    return remaining.slice(0, limit);
  });
  const blocking = yield* Effect.gen(function* () {
    if (phase !== "processes") return [];
    return yield* Effect.forEach(targets, (object) =>
      Effect.gen(function* () {
        const metadata = yield* Schema.decodeUnknownEffect(StoredRunMetadata)(
          object.customMetadata,
        ).pipe(Effect.mapError((cause) => new StorageFailure({ cause })));
        if (object.key !== `processes/${id}/${metadata.summary.id}.json`)
          return yield* new StorageFailure({ cause: "Reclamation process identity mismatch" });
        if (
          metadata.summary.status === "exited" ||
          metadata.summary.status === "failed" ||
          metadata.summary.status === "cancelled"
        )
          return [];
        return [metadata.summary.id];
      }),
    ).pipe(Effect.map((ids) => ids.flat()));
  });
  if (blocking.length > 0) return { phase, status: "blocked" as const, removed: 0, blocking };
  if (targets.length > 0) {
    yield* Effect.tryPromise({
      try: () => env.OBJECTS.delete(targets.map((object) => object.key)),
      catch: (cause) => new StorageFailure({ cause }),
    });
    return { phase, status: "pending" as const, removed: targets.length, blocking: [] };
  }
  const next = {
    processes: "inputs",
    inputs: "schedules",
    schedules: "objects",
    objects: "complete",
  } as const;
  if (phase === "objects" && targets.length === 0) {
    const manifest = yield* Effect.acquireUseRelease(
      kernelCall(() => new Kernel()),
      (kernel) => kernelCall(() => kernel.manifest()),
      (kernel) => Effect.sync(() => kernel.free()),
    );
    if (snapshot.head.manifest !== manifest || Object.keys(snapshot.head.environment).length > 0) {
      const compacted = yield* Effect.tryPromise({
        try: () =>
          env.OBJECTS.put(
            headKey,
            Schema.encodeSync(Schema.fromJsonString(Head))({
              ...snapshot.head,
              environment: {},
              manifest,
            }),
            { onlyIf: { etagMatches: snapshot.etag } },
          ),
        catch: (cause) => new StorageFailure({ cause }),
      });
      if (compacted === null)
        return yield* new Fault({
          code: "CONFLICT",
          status: 409,
          message: "Reclamation head changed; resume from persisted state",
        });
    }
  }
  const revision = yield* Effect.sync(() => crypto.randomUUID());
  const advanced = yield* Effect.tryPromise({
    try: () => {
      const body = Schema.encodeSync(Schema.fromJsonString(ReclamationState))({
        phase: next[phase],
        revision,
      });
      if (stored === null) return env.OBJECTS.put(key, body, { onlyIf: { etagDoesNotMatch: "*" } });
      return env.OBJECTS.put(key, body, { onlyIf: { etagMatches: stored.etag } });
    },
    catch: (cause) => new StorageFailure({ cause }),
  });
  if (advanced === null)
    return yield* new Fault({
      code: "CONFLICT",
      status: 409,
      message: "Reclamation progress changed; resume from persisted state",
    });
  if (next[phase] === "complete")
    return { phase: next[phase], status: "complete" as const, removed: 0, blocking: [] };
  return { phase: next[phase], status: "pending" as const, removed: targets.length, blocking: [] };
});
