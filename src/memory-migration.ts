import { Clock, Effect, Schema, Struct } from "effect";
import { pack_memory, unpack_memory } from "../dist/kernel/cirro_kernel";
import {
  ContextHeap,
  Digest,
  ExecutionCheckpoint,
  HeapSnapshot,
  Id,
  MemoryMigrationInput,
  MemoryMigrationReceipt,
  MemoryPages,
  StoredContext,
  StoredRun,
  checkpointMemoryCodec,
} from "./contracts";
import { memoryPackPlan } from "./memory";
import { StorageFailure } from "./storage";
import type { Env } from "./resources";
import { saveExecutionCheckpoint } from "./checkpoint";

const PreviousMemoryPages = MemoryPages.mapFields((fields) => Struct.omit(fields, ["codec"]), {
  unsafePreserveChecks: true,
});
const PackMigrationProgress = Schema.Struct({
  version: Schema.Literal(1),
  layout: Digest,
  completed: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 64 })),
});
export const migrateMemoryPages = Effect.fn("migration.memoryPacks")(function* (
  objects: Env["OBJECTS"],
  sandboxId: string,
  previous: typeof PreviousMemoryPages.Type,
) {
  const snapshot = yield* Schema.decodeUnknownEffect(MemoryPages)({
    ...previous,
    codec: checkpointMemoryCodec,
  }).pipe(Effect.mapError((cause) => new StorageFailure({ cause })));
  const layout = Buffer.from(
    yield* Effect.promise(() =>
      crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(Schema.encodeSync(Schema.fromJsonString(MemoryPages))(snapshot)),
      ),
    ),
  ).toString("hex");
  const packs = yield* memoryPackPlan(snapshot.pages);
  const progressKey = `sandboxes/${sandboxId}/checkpoint-pack-migrations/${layout}.json`;
  const retained = yield* Effect.tryPromise({
    try: () => objects.get(progressKey),
    catch: (cause) => new StorageFailure({ cause }),
  });
  const progress = yield* Effect.gen(function* () {
    if (retained === null) return { version: 1 as const, layout, completed: 0 };
    if (retained.size > 512)
      return yield* new StorageFailure({ cause: "Oversized memory migration progress" });
    return yield* Schema.decodeUnknownEffect(Schema.fromJsonString(PackMigrationProgress))(
      yield* Effect.tryPromise({
        try: () => retained.text(),
        catch: (cause) => new StorageFailure({ cause }),
      }),
    ).pipe(Effect.mapError((cause) => new StorageFailure({ cause })));
  });
  if (progress.layout !== layout || progress.completed > packs.length)
    return yield* new StorageFailure({
      cause: "Memory migration progress does not match its heap",
    });
  const batch = packs.slice(progress.completed, progress.completed + 4);
  yield* Effect.forEach(
    batch,
    (pack) =>
      Effect.gen(function* () {
        const bytes = new Uint8Array(pack.hashes.length * 65_536);
        for (const [index, hash] of pack.hashes.entries()) {
          const page = yield* Effect.tryPromise({
            try: () => objects.get(`sandboxes/${sandboxId}/checkpoint-pages/${hash}`),
            catch: (cause) => new StorageFailure({ cause }),
          });
          if (page === null || page.size !== 65_536)
            return yield* new StorageFailure({ cause: "Missing or oversized legacy heap page" });
          const raw = yield* Effect.tryPromise({
            try: () => page.arrayBuffer(),
            catch: (cause) => new StorageFailure({ cause }),
          });
          const digest = yield* Effect.promise(() => crypto.subtle.digest("SHA-256", raw));
          if (Buffer.from(digest).toString("hex") !== hash)
            return yield* new StorageFailure({ cause: "Legacy heap page digest mismatch" });
          bytes.set(new Uint8Array(raw), index * 65_536);
        }
        const encoded = yield* Effect.try({
          try: () => Uint8Array.from(pack_memory(bytes)),
          catch: (cause) => new StorageFailure({ cause }),
        });
        const key = `sandboxes/${sandboxId}/checkpoint-packs/${pack.hash}`;
        yield* Effect.tryPromise({
          try: () => objects.put(key, encoded, { onlyIf: { etagDoesNotMatch: "*" } }),
          catch: (cause) => new StorageFailure({ cause }),
        });
        const saved = yield* Effect.tryPromise({
          try: () => objects.get(key),
          catch: (cause) => new StorageFailure({ cause }),
        });
        if (
          saved === null ||
          saved.size === 0 ||
          saved.size > bytes.length + bytes.length / 128 + 64
        )
          return yield* new StorageFailure({ cause: "Missing or oversized migrated heap pack" });
        const stored = yield* Effect.tryPromise({
          try: () => saved.arrayBuffer(),
          catch: (cause) => new StorageFailure({ cause }),
        });
        const restored = yield* Effect.try({
          try: () => unpack_memory(new Uint8Array(stored), bytes.length),
          catch: (cause) => new StorageFailure({ cause }),
        });
        if (!bytes.every((byte, index) => byte === restored[index]))
          return yield* new StorageFailure({
            cause: "Migrated heap pack differs from legacy pages",
          });
      }),
    { concurrency: 1, discard: true },
  );
  const completed = progress.completed + batch.length;
  if (batch.length > 0) {
    const onlyIf = yield* Effect.sync(() => {
      if (retained === null) return { etagDoesNotMatch: "*" };
      return { etagMatches: retained.etag };
    });
    const saved = yield* Effect.tryPromise({
      try: () =>
        objects.put(
          progressKey,
          Schema.encodeSync(Schema.fromJsonString(PackMigrationProgress))({
            version: 1,
            layout,
            completed,
          }),
          { onlyIf },
        ),
      catch: (cause) => new StorageFailure({ cause }),
    });
    if (saved === null)
      return { snapshot, complete: false, completed: progress.completed, total: packs.length };
  }
  return { snapshot, complete: completed === packs.length, completed, total: packs.length };
});

const PreviousContextHeap = ContextHeap.mapFields((fields) => Struct.omit(fields, ["codec"]));
const PackedContext = StoredContext.mapFields((fields) => ({
  ...fields,
  language: Schema.optionalKey(fields.language),
}));
const UnpackedContext = PackedContext.mapFields((fields) => ({
  ...fields,
  heap: Schema.NullOr(PreviousContextHeap),
}));
const MigratingContext = Schema.Union([PackedContext, UnpackedContext]);
const PreviousHeapSnapshot = HeapSnapshot.mapFields((fields) => ({
  ...Struct.omit(fields, ["codec"]),
  version: Schema.Literal(1),
}));
const PreviousExecutionCheckpoint = ExecutionCheckpoint.mapFields((fields) => ({
  ...fields,
  version: Schema.Literal(1),
}));
const MigratingCheckpoint = Schema.Union([ExecutionCheckpoint, PreviousExecutionCheckpoint]);

export const migrateMemory = Effect.fn("migration.memory")(function* (
  env: Env,
  input: typeof MemoryMigrationInput.Type,
): Effect.fn.Return<typeof MemoryMigrationReceipt.Type, StorageFailure | Schema.SchemaError> {
  const cursor = input.cursor ?? { phase: "contexts" as const, continuation: null };
  const prefix = yield* Effect.sync(() => {
    if (cursor.phase === "contexts") return "sandboxes/";
    return "processes/";
  });
  const page = yield* Effect.tryPromise({
    try: () => env.OBJECTS.list({ prefix, limit: 25, cursor: cursor.continuation ?? undefined }),
    catch: (cause) => new StorageFailure({ cause }),
  });
  for (const entry of page.objects) {
    const parts = entry.key.split("/");
    if (cursor.phase === "contexts") {
      if (parts.length !== 4 || parts[2] !== "contexts" || !parts[3]?.endsWith(".json")) continue;
    } else if (parts.length !== 3 || !parts[2]?.endsWith(".json")) continue;
    const sandboxId = yield* Schema.decodeUnknownEffect(Id)(parts[1]);
    const object = yield* Effect.tryPromise({
      try: () => env.OBJECTS.get(entry.key),
      catch: (cause) => new StorageFailure({ cause }),
    });
    if (object === null) continue;
    if (object.size > 8_388_608)
      return yield* new StorageFailure({ cause: "Oversized memory migration record" });
    const text = yield* Effect.tryPromise({
      try: () => object.text(),
      catch: (cause) => new StorageFailure({ cause }),
    });
    if (cursor.phase === "contexts") {
      const record = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(MigratingContext), {
        onExcessProperty: "error",
      })(text);
      if (entry.key !== `sandboxes/${sandboxId}/contexts/${record.id}.json`)
        return yield* new StorageFailure({ cause: "Memory migration context identity mismatch" });
      if (record.heap === null || "codec" in record.heap) continue;
      const heap = record.heap;
      if (record.deadlineAt !== null && record.deadlineAt > (yield* Clock.currentTimeMillis))
        return { migrated: 0, cursor, retryAfterMs: 1000 };
      const converted = yield* migrateMemoryPages(env.OBJECTS, sandboxId, heap);
      if (!converted.complete) return { migrated: 0, cursor, retryAfterMs: 0 };
      const saved = yield* Effect.tryPromise({
        try: () =>
          env.OBJECTS.put(
            entry.key,
            Schema.encodeSync(Schema.fromJsonString(PackedContext))({
              ...record,
              heap: { ...heap, ...converted.snapshot },
            }),
            { onlyIf: { etagMatches: object.etag }, customMetadata: object.customMetadata },
          ),
        catch: (cause) => new StorageFailure({ cause }),
      });
      if (saved === null) return { migrated: 0, cursor, retryAfterMs: 0 };
      return { migrated: 1, cursor, retryAfterMs: 0 };
    }
    const record = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(StoredRun), {
      onExcessProperty: "error",
    })(text);
    if (entry.key !== `processes/${sandboxId}/${record.id}.json`)
      return yield* new StorageFailure({ cause: "Memory migration process identity mismatch" });
    if (record.checkpoint === null) continue;
    if (
      (record.status === "running" || record.status === "cancelling") &&
      record.deadlineAt !== null &&
      record.deadlineAt > (yield* Clock.currentTimeMillis)
    )
      return { migrated: 0, cursor, retryAfterMs: 1000 };
    const checkpointObject = yield* Effect.tryPromise({
      try: () =>
        env.OBJECTS.get(`sandboxes/${sandboxId}/execution-checkpoints/${record.checkpoint}.json`),
      catch: (cause) => new StorageFailure({ cause }),
    });
    if (checkpointObject === null || checkpointObject.size > 16_777_216)
      return yield* new StorageFailure({
        cause: "Missing or oversized migrating execution checkpoint",
      });
    const checkpointBytes = yield* Effect.tryPromise({
      try: () => checkpointObject.arrayBuffer(),
      catch: (cause) => new StorageFailure({ cause }),
    });
    const checkpointHash = Buffer.from(
      yield* Effect.promise(() => crypto.subtle.digest("SHA-256", checkpointBytes)),
    ).toString("hex");
    if (checkpointHash !== record.checkpoint)
      return yield* new StorageFailure({ cause: "Migrating execution checkpoint digest mismatch" });
    const checkpoint = yield* Schema.decodeUnknownEffect(
      Schema.fromJsonString(MigratingCheckpoint),
    )(Buffer.from(checkpointBytes).toString());
    if (checkpoint.version === 2) {
      if (record.status === "queued")
        yield* Effect.tryPromise({
          try: () => env.EVENTS.send({ key: entry.key, eTag: object.etag }),
          catch: (cause) => new StorageFailure({ cause }),
        });
      continue;
    }
    const heapObject = yield* Effect.tryPromise({
      try: () => env.OBJECTS.get(`sandboxes/${sandboxId}/checkpoints/${checkpoint.heap}.json`),
      catch: (cause) => new StorageFailure({ cause }),
    });
    if (heapObject === null || heapObject.size > 131_072)
      return yield* new StorageFailure({ cause: "Missing or oversized migrating heap" });
    const heapBytes = yield* Effect.tryPromise({
      try: () => heapObject.arrayBuffer(),
      catch: (cause) => new StorageFailure({ cause }),
    });
    const heapHash = Buffer.from(
      yield* Effect.promise(() => crypto.subtle.digest("SHA-256", heapBytes)),
    ).toString("hex");
    if (heapHash !== checkpoint.heap)
      return yield* new StorageFailure({ cause: "Migrating heap manifest digest mismatch" });
    const heap = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(PreviousHeapSnapshot))(
      Buffer.from(heapBytes).toString(),
    );
    const converted = yield* migrateMemoryPages(env.OBJECTS, sandboxId, heap);
    if (!converted.complete) return { migrated: 0, cursor, retryAfterMs: 0 };
    const encoded = new TextEncoder().encode(
      Schema.encodeSync(Schema.fromJsonString(HeapSnapshot))({
        ...heap,
        ...converted.snapshot,
        version: 2,
      }),
    );
    const hash = Buffer.from(
      yield* Effect.promise(() => crypto.subtle.digest("SHA-256", encoded)),
    ).toString("hex");
    yield* Effect.tryPromise({
      try: () =>
        env.OBJECTS.put(`sandboxes/${sandboxId}/checkpoints/${hash}.json`, encoded, {
          onlyIf: { etagDoesNotMatch: "*" },
        }),
      catch: (cause) => new StorageFailure({ cause }),
    });
    const reference = yield* saveExecutionCheckpoint(env.OBJECTS, sandboxId, {
      ...checkpoint,
      version: 2,
      heap: hash,
    });
    const saved = yield* Effect.tryPromise({
      try: () =>
        env.OBJECTS.put(
          entry.key,
          Schema.encodeSync(Schema.fromJsonString(StoredRun))({
            ...record,
            checkpoint: reference,
          }),
          { onlyIf: { etagMatches: object.etag }, customMetadata: object.customMetadata },
        ),
      catch: (cause) => new StorageFailure({ cause }),
    });
    if (saved === null) return { migrated: 0, cursor, retryAfterMs: 0 };
    if (record.status === "queued")
      yield* Effect.tryPromise({
        try: () => env.EVENTS.send({ key: entry.key, eTag: saved.etag }),
        catch: (cause) => new StorageFailure({ cause }),
      });
    return { migrated: 1, cursor, retryAfterMs: 0 };
  }
  if (page.truncated)
    return { migrated: 0, cursor: { ...cursor, continuation: page.cursor }, retryAfterMs: 0 };
  if (cursor.phase === "contexts")
    return { migrated: 0, cursor: { phase: "processes", continuation: null }, retryAfterMs: 0 };
  return { migrated: 0, cursor: null, retryAfterMs: 0 };
});
