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
