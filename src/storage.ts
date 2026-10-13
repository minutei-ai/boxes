import { Clock, Effect, Schema } from "effect";
import { Kernel } from "../dist/kernel/cirro_kernel";
import { Chunks, Fault, FileStat, Head } from "./contracts";
import type { Env } from "./resources";

export class StorageFailure extends Schema.TaggedError<StorageFailure>()("StorageFailure", {
  cause: Schema.Unknown,
}) {}
export const open = Effect.fn("filesystem.open")(function* (env: Env, id: string) {
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
  if (head.deleted)
    return yield* new Fault({ code: "ENOENT", status: 404, message: "Sandbox has been disposed" });
  const kernel = yield* Effect.acquireRelease(
    kernelCall(() => new Kernel(head.manifest)).pipe(
      Effect.mapError((cause) => new StorageFailure({ cause })),
    ),
    (kernel) => Effect.sync(() => kernel.free()),
  );
  return { head, kernel, etag: object.etag };
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
        if (code === "EEXIST" || code === "ENOTEMPTY")
          return new Fault({ code, status: 409, message: cause });
        if (code === "ENOSPC" || code === "EFBIG")
          return new Fault({ code, status: 413, message: cause });
        if (["ENOTDIR", "EISDIR", "ELOOP"].includes(code))
          return new Fault({ code, status: 400, message: cause });
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

export const read = Effect.fn("filesystem.read")(function* (
  env: Env,
  id: string,
  kernel: Kernel,
  path: string,
  forWrite = false,
) {
  const refs = yield* kernelCall(() => kernel.chunks(path, forWrite));
  const hashes = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Chunks))(refs);
  const metadata = yield* kernelCall(() => kernel.stat(path, true)).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(FileStat))),
  );
  const blocks = yield* Effect.forEach(
    hashes,
    (hash, index) =>
      Effect.gen(function* () {
        const object = yield* Effect.tryPromise({
          try: () => env.OBJECTS.get(`sandboxes/${id}/blobs/${hash}`),
          catch: (cause) => new StorageFailure({ cause }),
        });
        if (object === null)
          return yield* new Fault({
            code: "EIO",
            status: 500,
            message: "Missing file content block",
          });
        const expected = Math.min(262_144, metadata.size - index * 262_144);
        if (object.size !== expected)
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
        if (Buffer.from(digest).toString("hex") !== hash)
          return yield* new Fault({
            code: "EIO",
            status: 500,
            message: "File content checksum mismatch",
          });
        return Buffer.from(data);
      }),
    { concurrency: 4 },
  );
  return Buffer.concat(blocks);
});

export const write = Effect.fn("filesystem.write")(function* (
  env: Env,
  id: string,
  kernel: Kernel,
  path: string,
  data: Uint8Array,
) {
  if (data.byteLength > 16_777_216)
    return yield* new Fault({ code: "EFBIG", status: 413, message: "Maximum file size is 16 MiB" });
  const now = yield* Clock.currentTimeNanos;
  yield* kernelCall(() => kernel.set_time(now));
  const blocks = Array.from({ length: Math.ceil(data.byteLength / 262_144) }, (_, index) =>
    data.subarray(index * 262_144, (index + 1) * 262_144),
  );
  const hashes = yield* Effect.forEach(
    blocks,
    (block) =>
      Effect.promise(async () => {
        const digest = await crypto.subtle.digest("SHA-256", Uint8Array.from(block));
        return Buffer.from(digest).toString("hex");
      }),
    { concurrency: 4 },
  );
  const needed = yield* kernelCall(() =>
    kernel.prepare_write(
      path,
      BigInt(data.byteLength),
      Schema.encodeSync(Schema.fromJsonString(Chunks))(hashes),
    ),
  ).pipe(Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(Chunks))));
  yield* Effect.forEach(
    needed,
    (hash) =>
      Effect.tryPromise({
        try: () =>
          env.OBJECTS.put(`sandboxes/${id}/blobs/${hash}`, blocks[hashes.indexOf(hash)], {
            onlyIf: { etagDoesNotMatch: "*" },
          }),
        catch: (cause) => new StorageFailure({ cause }),
      }),
    { concurrency: 4 },
  );
  yield* kernelCall(() =>
    kernel.write(
      path,
      BigInt(data.byteLength),
      Schema.encodeSync(Schema.fromJsonString(Chunks))(hashes),
    ),
  );
});
