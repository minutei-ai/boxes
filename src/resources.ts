import * as Cloudflare from "alchemy/Cloudflare";
import * as Alchemy from "alchemy";
import { Config, Effect, Schema, Stream } from "effect";
import { defaultSoftware } from "./default-software";
import { Digest } from "./contracts";
import { prepareSoftwareBase, SoftwareBaseInput } from "../tooling/software-base";

export const bucket = Cloudflare.R2.Bucket("Objects", { publicAccess: false });
export const executions = Cloudflare.Queues.Queue("Executions");
export const softwareBase = Alchemy.Action(
  "DefaultSoftware",
  Effect.gen(function* () {
    const objects = yield* Cloudflare.R2.ReadWriteBucket(bucket);
    return Effect.fn("deployment.softwareBase")(function* (input: typeof SoftwareBaseInput.Type) {
      const base = yield* prepareSoftwareBase(input);
      const changed = yield* Effect.filter(
        base.blocks,
        Effect.fn("deployment.verifySoftwareBlock")(function* ([hash, bytes]) {
          const previous = yield* objects.get(`software/blobs/${hash}`);
          if (previous === null) return true;
          const content = { size: 0, digest: new Bun.CryptoHasher("sha256") };
          yield* Stream.runForEachWhile(previous.body, (part) =>
            Effect.sync(() => {
              content.size += part.byteLength;
              if (content.size > bytes.byteLength) return false;
              content.digest.update(part);
              return true;
            }),
          );
          if (content.size !== bytes.byteLength) return true;
          return content.digest.digest("hex") !== hash;
        }),
        { concurrency: 1 },
      );
      yield* Effect.forEach(
        changed,
        ([hash, bytes]) => objects.put(`software/blobs/${hash}`, bytes),
        { concurrency: 1, discard: true },
      );
      yield* objects.put(`software/bases/${base.digest}.json`, base.manifest, {
        httpMetadata: { contentType: "application/json" },
      });
      const receipt = {
        digest: Schema.decodeUnknownSync(Digest)(base.digest),
        blocks: base.blocks.size,
        uploadedBlocks: changed.length,
        uploadedBytes: changed.reduce((total, [, bytes]) => total + bytes.byteLength, 0),
      };
      yield* Effect.logInfo({ operation: "deployment.softwareBase", ...receipt });
      return receipt;
    });
  }).pipe(Effect.provide(Cloudflare.R2.ReadWriteBucketLocal)),
);
export const worker = Effect.gen(function* () {
  const objects = yield* bucket;
  const events = yield* executions;
  const key = yield* Config.Redacted("CIRRO_API_KEY");
  const kernelDigest = yield* Effect.promise(async () =>
    new Bun.CryptoHasher("sha256")
      .update(
        await Bun.file(
          new URL("../dist/kernel/cirro_kernel_bg.wasm", import.meta.url),
        ).arrayBuffer(),
      )
      .digest("hex"),
  );
  const base = yield* softwareBase({ kernelDigest, artifacts: defaultSoftware });
  return yield* Cloudflare.Worker("Sandbox", {
    main: new URL("../dist/worker/index.js", import.meta.url).pathname,
    bundle: false,
    compatibility: { date: "2026-10-06", flags: ["nodejs_compat", "enable_request_signal"] },
    limits: { cpuMs: 30_000 },
    placement: { mode: "smart" },
    crons: ["* * * * *"],
    env: { OBJECTS: objects, API_KEY: key, EVENTS: events, SOFTWARE_BASE: base.digest },
  });
});
export type Env = Cloudflare.InferEnv<Effect.Success<typeof worker>>;
