import { Effect } from "effect";
import type { CapturedStdio, Fault, ObservedOutput, StoredOutput, StdioRef } from "./contracts";
import { StorageFailure } from "./storage";
import type { Env } from "./resources";

export type OutputCapture = (
  stdio: typeof CapturedStdio.Type,
) => Effect.Effect<void, StorageFailure | Fault>;

const chunkBytes = 65_536;

export const archiveOutput = Effect.fn("output.archive")(function* (
  env: Env,
  sandboxId: string,
  output: typeof ObservedOutput.Type,
  previous: typeof StoredOutput.Type | null,
) {
  const streams = yield* Effect.forEach(["stdout", "stderr"] as const, (stream) =>
    Effect.gen(function* () {
      const bytes = Buffer.from(output[stream], "utf8");
      if (bytes.length > 2_097_152)
        return yield* new StorageFailure({ cause: "Oversized output stream" });
      const chunks: string[] = [];
      for (const offset of Array.from(
        { length: Math.ceil(bytes.length / chunkBytes) },
        (_, index) => index * chunkBytes,
      )) {
        const block = bytes.subarray(offset, offset + chunkBytes);
        const digest = yield* Effect.promise(() => crypto.subtle.digest("SHA-256", block));
        const hash = Buffer.from(digest).toString("hex");
        if (previous?.[stream].chunks[chunks.length] !== hash)
          yield* Effect.tryPromise({
            try: () =>
              env.OBJECTS.put(`sandboxes/${sandboxId}/stdio/${hash}`, block, {
                onlyIf: { etagDoesNotMatch: "*" },
              }),
            catch: (cause) => new StorageFailure({ cause }),
          });
        chunks.push(hash);
      }
      return { size: bytes.length, chunks };
    }),
  );
  const [stdout, stderr] = streams;
  if (stdout === undefined || stderr === undefined)
    return yield* new StorageFailure({ cause: "Missing output stream" });
  return { ...output, stdout, stderr };
});

export const readOutputRange = Effect.fn("output.readRange")(function* (
  env: Env,
  sandboxId: string,
  stream: typeof StdioRef.Type,
  offset: number,
  length: number,
) {
  if (
    stream.chunks.length !== Math.ceil(stream.size / chunkBytes) ||
    offset < 0 ||
    length < 0 ||
    offset + length > stream.size
  )
    return yield* new StorageFailure({ cause: "Invalid retained output range" });
  if (length === 0) return Buffer.alloc(0);
  const first = Math.floor(offset / chunkBytes);
  const last = Math.floor((offset + length - 1) / chunkBytes);
  const blocks = yield* Effect.forEach(
    Array.from({ length: last - first + 1 }, (_, index) => first + index),
    (index) =>
      Effect.gen(function* () {
        const hash = stream.chunks[index];
        const object = yield* Effect.tryPromise({
          try: () => env.OBJECTS.get(`sandboxes/${sandboxId}/stdio/${hash}`),
          catch: (cause) => new StorageFailure({ cause }),
        });
        const size = Math.min(chunkBytes, stream.size - index * chunkBytes);
        if (object === null || object.size !== size)
          return yield* new StorageFailure({
            cause: "Retained output block missing or wrong size",
          });
        const bytes = yield* Effect.tryPromise({
          try: () => object.arrayBuffer(),
          catch: (cause) => new StorageFailure({ cause }),
        });
        const digest = yield* Effect.promise(() => crypto.subtle.digest("SHA-256", bytes));
        if (Buffer.from(digest).toString("hex") !== hash)
          return yield* new StorageFailure({ cause: "Retained output block digest mismatch" });
        return Buffer.from(bytes);
      }),
    { concurrency: 4 },
  );
  return Buffer.concat(blocks).subarray(
    offset - first * chunkBytes,
    offset - first * chunkBytes + length,
  );
});

export const restoreOutput = Effect.fn("output.restore")(function* (
  env: Env,
  sandboxId: string,
  output: typeof StoredOutput.Type,
) {
  const stdout = yield* readOutputRange(env, sandboxId, output.stdout, 0, output.stdout.size);
  const stderr = yield* readOutputRange(env, sandboxId, output.stderr, 0, output.stderr.size);
  return { ...output, stdout: stdout.toString("utf8"), stderr: stderr.toString("utf8") };
});
