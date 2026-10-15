import { Clock, Effect, Schema } from "effect";
import { Kernel } from "../dist/kernel/cirro_kernel";
import { Chunks, Fault, Head, ContentBlock, ReadPlan, type RangeWritePlan } from "./contracts";
import type { Env } from "./resources";

export class StorageFailure extends Schema.TaggedError<StorageFailure>()("StorageFailure", {
  cause: Schema.Unknown,
}) {}
export const readHead = Effect.fn("sandbox.readHead")(function* (env: Env, id: string) {
  const object = yield* Effect.tryPromise({
    try: () => env.OBJECTS.get(`sandboxes/${id}/head.json`),
    catch: (cause) => new StorageFailure({ cause }),
  });
  if (object === null)
    return yield* new Fault({ code: "ENOENT", status: 404, message: "Sandbox does not exist" });
  const text = yield* Effect.tryPromise({
    try: () => object.text(),
    catch: (cause) => new StorageFailure({ cause }),
  });
  const head = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Head))(text).pipe(
    Effect.mapError((cause) => new StorageFailure({ cause })),
  );
  return { head, etag: object.etag };
});
export const head = Effect.fn("sandbox.head")(function* (env: Env, id: string) {
  const snapshot = yield* readHead(env, id);
  if (snapshot.head.deleted)
    return yield* new Fault({ code: "ENOENT", status: 404, message: "Sandbox has been disposed" });
  return snapshot;
});
export const observeDisposal = Effect.fn("sandbox.observeDisposal")(function* (
  env: Env,
  id: string,
  etag: string | null,
) {
  const object = yield* Effect.tryPromise({
    try: () => {
      if (etag === null) return env.OBJECTS.get(`sandboxes/${id}/head.json`);
      return env.OBJECTS.get(`sandboxes/${id}/head.json`, {
        onlyIf: { etagDoesNotMatch: etag },
      });
    },
    catch: (cause) => new StorageFailure({ cause }),
  });
  if (object === null)
    return yield* new Fault({
      code: "ECANCELED",
      status: 409,
      message: "Execution sandbox disappeared",
    });
  if (!("body" in object)) return object.etag;
  const text = yield* Effect.tryPromise({
    try: () => object.text(),
    catch: (cause) => new StorageFailure({ cause }),
  });
  const current = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Head))(text).pipe(
    Effect.mapError((cause) => new StorageFailure({ cause })),
  );
  if (current.deleted)
    return yield* new Fault({
      code: "ECANCELED",
      status: 409,
      message: "Execution sandbox was disposed",
    });
  return object.etag;
});
export const dispose = Effect.fn("sandbox.dispose")(function* (env: Env, id: string) {
  const snapshot = yield* readHead(env, id);
  if (snapshot.head.deleted) return;
  const written = yield* Effect.tryPromise({
    try: () =>
      env.OBJECTS.put(
        `sandboxes/${id}/head.json`,
        Schema.encodeSync(Schema.fromJsonString(Head))({ ...snapshot.head, deleted: true }),
        {
          onlyIf: { etagMatches: snapshot.etag },
          httpMetadata: { contentType: "application/json" },
        },
      ),
    catch: (cause) => new StorageFailure({ cause }),
  });
  if (written !== null) return;
  const current = yield* readHead(env, id);
  if (current.head.deleted) return;
  return yield* new Fault({
    code: "CONFLICT",
    status: 409,
    message: "Sandbox changed concurrently; read current state before retrying",
  });
});
export const open = Effect.fn("filesystem.open")(function* (env: Env, id: string) {
  const snapshot = yield* head(env, id);
  const kernel = yield* Effect.acquireRelease(
    kernelCall(() => new Kernel(snapshot.head.manifest)).pipe(
      Effect.mapError((cause) => new StorageFailure({ cause })),
    ),
    (kernel) => Effect.sync(() => kernel.free()),
  );
  return { ...snapshot, kernel };
});

export const kernelCall = <A>(call: () => A) =>
  Effect.try({
    try: call,
    catch: (cause) => {
      if (Schema.is(Schema.String)(cause)) {
        const code = cause.split(":")[0];
        if (code === "ENOENT") return new Fault({ code, status: 404, message: cause });
        if (code === "EACCES" || code === "EPERM" || code === "EROFS")
          return new Fault({ code, status: 403, message: cause });
        if (code === "EEXIST" || code === "ENOTEMPTY" || code === "CONFLICT")
          return new Fault({ code, status: 409, message: cause });
        if (code === "ENOSPC" || code === "EFBIG")
          return new Fault({ code, status: 413, message: cause });
        if (["ENOTDIR", "EISDIR", "ELOOP", "READONLY", "ENOEXEC"].includes(code))
          return new Fault({ code, status: 400, message: cause });
        if (code === "EILSEQ") return new Fault({ code, status: 422, message: cause });
        if (code === "UNSUPPORTED_RUNTIME") return new Fault({ code, status: 501, message: cause });
        return new Fault({ code: "EINVAL", status: 400, message: cause });
      }
      return new StorageFailure({ cause });
    },
  });

export const publish = Effect.fn("filesystem.publish")(function* (
  env: Env,
  id: string,
  session: Effect.Success<ReturnType<typeof open>>,
) {
  yield* kernelCall(() => session.kernel.advance());
  const manifest = yield* kernelCall(() => session.kernel.manifest());
  const body = Schema.encodeSync(Schema.fromJsonString(Head))({ ...session.head, manifest });
  const written = yield* Effect.tryPromise({
    try: () =>
      env.OBJECTS.put(`sandboxes/${id}/head.json`, body, {
        onlyIf: { etagMatches: session.etag },
        httpMetadata: { contentType: "application/json" },
      }),
    catch: (cause) => new StorageFailure({ cause }),
  });
  if (written === null)
    return yield* new Fault({
      code: "CONFLICT",
      status: 409,
      message: "Sandbox changed concurrently; read current state before retrying",
    });
  session.head = { ...session.head, manifest };
  session.etag = written.etag;
  return written.etag;
});

const block = Effect.fn("filesystem.block")(function* (
  env: Env,
  id: string,
  reference: typeof ContentBlock.Type,
) {
  const object = yield* Effect.tryPromise({
    try: () => env.OBJECTS.get(`sandboxes/${id}/blobs/${reference.hash}`),
    catch: (cause) => new StorageFailure({ cause }),
  });
  if (object === null)
    return yield* new Fault({ code: "EIO", status: 500, message: "Missing file content block" });
  if (object.size !== reference.size)
    return yield* new Fault({
      code: "EIO",
      status: 500,
      message: "File content block length mismatch",
    });
  const data = yield* Effect.tryPromise({
    try: () => object.arrayBuffer(),
    catch: (cause) => new StorageFailure({ cause }),
  });
  const digest = yield* Effect.promise(() => crypto.subtle.digest("SHA-256", data));
  if (Buffer.from(digest).toString("hex") !== reference.hash)
    return yield* new Fault({
      code: "EIO",
      status: 500,
      message: "File content checksum mismatch",
    });
  return Buffer.from(data);
});

export const read = Effect.fn("filesystem.read")(function* (
  env: Env,
  id: string,
  kernel: Kernel,
  target: string | bigint,
  forWrite = false,
  offset = 0,
  length = 16_777_216,
) {
  const plan = yield* kernelCall(() => {
    if (typeof target === "bigint")
      return kernel.read_inode_plan(target, BigInt(offset), BigInt(length));
    return kernel.read_plan(target, BigInt(offset), BigInt(length), forWrite);
  }).pipe(Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(ReadPlan))));
  const blocks = yield* Effect.forEach(plan.blocks, (reference) => block(env, id, reference), {
    concurrency: 4,
  });
  return Buffer.concat(blocks).subarray(plan.skip, plan.skip + plan.length);
});

export const applyWritePlan = Effect.fn("filesystem.applyWritePlan")(function* (
  env: Env,
  id: string,
  kernel: Kernel,
  plan: typeof RangeWritePlan.Type,
  data: Uint8Array,
) {
  if (!plan.changed) return false;
  const now = yield* Clock.currentTimeNanos;
  yield* kernelCall(() => kernel.set_time(now));
  const patches = yield* Effect.forEach(
    plan.blocks,
    (patch) =>
      Effect.gen(function* () {
        const bytes = Buffer.alloc(patch.size);
        const start = patch.index * 262_144;
        if (
          patch.previous !== null &&
          (plan.offset > start || plan.offset + data.byteLength < start + patch.previous.size)
        ) {
          const previous = yield* block(env, id, patch.previous);
          bytes.set(previous.subarray(0, patch.size));
        }
        const from = Math.max(start, plan.offset);
        const to = Math.min(start + patch.size, plan.offset + data.byteLength);
        if (to > from) bytes.set(data.subarray(from - plan.offset, to - plan.offset), from - start);
        const digest = yield* Effect.promise(() => crypto.subtle.digest("SHA-256", bytes));
        return { index: patch.index, hash: Buffer.from(digest).toString("hex"), bytes };
      }),
    { concurrency: 4 },
  );
  const hashes = plan.chunks.map((hash, index) => {
    const patch = patches.find((patch) => patch.index === index);
    if (patch !== undefined) return patch.hash;
    return hash;
  });
  const references = yield* Schema.decodeUnknownEffect(Chunks)(hashes);
  const encoded = Schema.encodeSync(Schema.fromJsonString(Chunks))(references);
  const needed = yield* kernelCall(() =>
    kernel.prepare_write(plan.path, BigInt(plan.size), encoded),
  ).pipe(Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(Chunks))));
  yield* Effect.forEach(
    needed,
    (hash) =>
      Effect.gen(function* () {
        const patch = patches.find((patch) => patch.hash === hash);
        if (patch === undefined)
          return yield* new Fault({
            code: "EIO",
            status: 500,
            message: "Range write has no content for a new digest",
          });
        yield* Effect.tryPromise({
          try: () =>
            env.OBJECTS.put(`sandboxes/${id}/blobs/${hash}`, patch.bytes, {
              onlyIf: { etagDoesNotMatch: "*" },
            }),
          catch: (cause) => new StorageFailure({ cause }),
        });
      }),
    { concurrency: 4 },
  );
  yield* kernelCall(() => kernel.write(plan.path, BigInt(plan.size), encoded));
  return true;
});

const WriteContent = Schema.Array(
  Schema.Struct({ hash: ContentBlock.fields.hash, bytes: Schema.Uint8Array }),
);
const prepareContent = Effect.fn("filesystem.prepareContent")(function* (
  kernel: Kernel,
  data: Uint8Array,
): Effect.fn.Return<typeof WriteContent.Type, Fault | StorageFailure> {
  if (data.byteLength > 16_777_216)
    return yield* new Fault({ code: "EFBIG", status: 413, message: "Maximum file size is 16 MiB" });
  const now = yield* Clock.currentTimeNanos;
  yield* kernelCall(() => kernel.set_time(now));
  const blocks = Array.from({ length: Math.ceil(data.byteLength / 262_144) }, (_, index) =>
    data.subarray(index * 262_144, (index + 1) * 262_144),
  );
  return yield* Effect.forEach(
    blocks,
    (block) =>
      Effect.promise(async () => {
        const digest = await crypto.subtle.digest("SHA-256", Uint8Array.from(block));
        return { hash: Buffer.from(digest).toString("hex"), bytes: block };
      }),
    { concurrency: 4 },
  );
});
const requiredBlocks = Effect.fn("filesystem.requiredBlocks")(function* (
  content: typeof WriteContent.Type,
  needed: typeof Chunks.Type,
) {
  const blocks = yield* Effect.forEach(needed, (hash) =>
    Effect.gen(function* () {
      const block = content.find((block) => block.hash === hash);
      if (block === undefined)
        return yield* new StorageFailure({ cause: "Kernel requested content outside the write" });
      return [hash, block.bytes] as const;
    }),
  );
  return new Map(blocks);
});
export const uploadBlocks = Effect.fn("filesystem.uploadBlocks")(function* (
  env: Env,
  id: string,
  blocks: ReadonlyMap<typeof ContentBlock.Type.hash, Uint8Array>,
) {
  yield* Effect.forEach(
    blocks,
    ([hash, bytes]) =>
      Effect.tryPromise({
        try: () =>
          env.OBJECTS.put(`sandboxes/${id}/blobs/${hash}`, bytes, {
            onlyIf: { etagDoesNotMatch: "*" },
          }),
        catch: (cause) => new StorageFailure({ cause }),
      }),
    { concurrency: 4 },
  );
});
export const stageWrite = Effect.fn("filesystem.stageWrite")(function* (
  kernel: Kernel,
  target: string,
  data: Uint8Array,
) {
  const content = yield* prepareContent(kernel, data);
  const encoded = Schema.encodeSync(Schema.fromJsonString(Chunks))(
    content.map((block) => block.hash),
  );
  const needed = yield* kernelCall(() =>
    kernel.write(target, BigInt(data.byteLength), encoded),
  ).pipe(Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(Chunks))));
  return yield* requiredBlocks(content, needed);
});
export const write = Effect.fn("filesystem.write")(function* (
  env: Env,
  id: string,
  kernel: Kernel,
  target: string | bigint,
  data: Uint8Array,
) {
  const content = yield* prepareContent(kernel, data);
  const encoded = Schema.encodeSync(Schema.fromJsonString(Chunks))(
    content.map((block) => block.hash),
  );
  const needed = yield* kernelCall(() => {
    if (typeof target === "bigint")
      return kernel.prepare_inode_write(target, BigInt(data.byteLength), encoded);
    return kernel.prepare_write(target, BigInt(data.byteLength), encoded);
  }).pipe(Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(Chunks))));
  yield* uploadBlocks(env, id, yield* requiredBlocks(content, needed));
  yield* kernelCall(() => {
    if (typeof target === "bigint")
      return kernel.write_inode(target, BigInt(data.byteLength), encoded);
    return kernel.write(target, BigInt(data.byteLength), encoded);
  });
});
