import { Effect, Schema } from "effect";
import { Program } from "./contracts";
import { StorageFailure } from "./storage";
import type { Env } from "./resources";

export const archive = Effect.fn("code.archive")(function* (
  env: Env,
  id: string,
  program: typeof Program.Type,
) {
  const source = Buffer.from(Schema.encodeSync(Schema.fromJsonString(Program))(program), "utf8");
  const digest = yield* Effect.promise(() => crypto.subtle.digest("SHA-256", source));
  const hash = Buffer.from(digest).toString("hex");
  yield* Effect.tryPromise({
    try: () =>
      env.OBJECTS.put(`sandboxes/${id}/code/${hash}`, source, {
        onlyIf: { etagDoesNotMatch: "*" },
        customMetadata: { format: "program-json" },
        httpMetadata: { contentType: "application/json" },
      }),
    catch: (cause) => new StorageFailure({ cause }),
  });
  return hash;
});

export const restore = Effect.fn("code.restore")(function* (
  env: Env,
  sandboxId: string,
  hash: string,
) {
  const object = yield* Effect.tryPromise({
    try: () => env.OBJECTS.get(`sandboxes/${sandboxId}/code/${hash}`),
    catch: (cause) => new StorageFailure({ cause }),
  });
  if (object === null || object.size > 18_000_000)
    return yield* new StorageFailure({ cause: "Archived program missing or oversized" });
  const bytes = yield* Effect.tryPromise({
    try: () => object.arrayBuffer(),
    catch: (cause) => new StorageFailure({ cause }),
  });
  const digest = yield* Effect.promise(() => crypto.subtle.digest("SHA-256", bytes));
  if (Buffer.from(digest).toString("hex") !== hash)
    return yield* new StorageFailure({ cause: "Archived program digest mismatch" });
  return yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Program))(
    Buffer.from(bytes).toString("utf8"),
  ).pipe(Effect.mapError((cause) => new StorageFailure({ cause })));
});
