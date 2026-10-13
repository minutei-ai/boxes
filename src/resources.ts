import * as Cloudflare from "alchemy/Cloudflare";
import { Config, Effect } from "effect";

export const bucket = Cloudflare.R2.Bucket("Objects", { publicAccess: false });
export const worker = Effect.gen(function* () {
  const objects = yield* bucket;
  const key = yield* Config.Redacted("CIRRO_API_KEY");
  return yield* Cloudflare.Worker("Sandbox", {
    main: new URL("../dist/worker/index.js", import.meta.url).pathname,
    bundle: false,
    compatibility: { date: "2026-10-06", flags: ["nodejs_compat", "enable_request_signal"] },
    env: { OBJECTS: objects, LOADER: Cloudflare.WorkerLoader("LOADER"), API_KEY: key },
  });
});
export type Env = Cloudflare.InferEnv<Effect.Success<typeof worker>>;
