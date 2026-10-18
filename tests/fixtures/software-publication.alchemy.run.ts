import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Output from "alchemy/Output";
import { Effect, Schema } from "effect";
import { bucket, softwareBase } from "../../src/resources";
import { Digest } from "../../src/contracts";
import { defaultSoftware } from "../../src/default-software";
import { prepareSoftwareBase, SoftwareBaseInput } from "../../tooling/software-base";

const DamageInput = Schema.Struct({ ...SoftwareBaseInput.fields, digest: Digest });
const snapshot = Alchemy.Action(
  "Snapshot",
  Effect.gen(function* () {
    const objects = yield* Cloudflare.R2.ReadWriteBucket(bucket);
    return Effect.fn("proof.snapshotSoftware")(function* (input: typeof DamageInput.Type) {
      const base = yield* prepareSoftwareBase({
        kernelDigest: input.kernelDigest,
        artifacts: input.artifacts,
      });
      if (base.digest !== input.digest) return yield* Effect.die("Wrong snapshot image");
      const versions = yield* Effect.forEach(
        base.blocks.keys(),
        Effect.fn("proof.softwareVersion")(function* (hash) {
          const object = yield* objects.head(`software/blobs/${hash}`);
          if (object === null || object.version.length === 0)
            return yield* Effect.die("Missing native object version");
          return object.version;
        }),
      );
      return { versions };
    });
  }).pipe(Effect.provide(Cloudflare.R2.ReadWriteBucketLocal)),
);
const ChangedInput = Schema.Struct({
  ...DamageInput.fields,
  versions: Schema.Array(Schema.String),
});
const damage = Alchemy.Action(
  "Damage",
  Effect.gen(function* () {
    const objects = yield* Cloudflare.R2.ReadWriteBucket(bucket);
    return Effect.fn("proof.damageSoftware")(function* (input: typeof ChangedInput.Type) {
      const base = yield* prepareSoftwareBase({
        kernelDigest: input.kernelDigest,
        artifacts: input.artifacts,
      });
      if (base.digest !== input.digest) return yield* Effect.die("Wrong proof image");
      if (input.versions.length !== base.blocks.size)
        return yield* Effect.die("Wrong version count");
      for (const [index, hash] of Array.from(base.blocks.keys()).entries()) {
        const object = yield* objects.head(`software/blobs/${hash}`);
        if (object === null || object.version !== input.versions[index])
          return yield* Effect.die("Warm publication rewrote an unchanged block");
      }
      const entries = Array.from(base.blocks);
      const missing = entries[0];
      const changed = entries[1];
      const oversized = entries[2];
      if (missing === undefined || changed === undefined || oversized === undefined)
        return yield* Effect.die("Proof requires three distinct blocks");
      yield* objects.delete(`software/blobs/${missing[0]}`);
      const bytes = Uint8Array.from(changed[1]);
      bytes[0] = bytes[0] ^ 1;
      yield* objects.put(`software/blobs/${changed[0]}`, bytes);
      yield* objects.put(`software/blobs/${oversized[0]}`, new Uint8Array(oversized[1].length + 1));
      return { removed: missing[0] };
    });
  }).pipe(Effect.provide(Cloudflare.R2.ReadWriteBucketLocal)),
);
const VerifyInput = Schema.Struct({
  ...DamageInput.fields,
  cold: Schema.Int,
  warm: Schema.Int,
  repaired: Schema.Int,
});
const verify = Alchemy.Action(
  "Verify",
  Effect.gen(function* () {
    const objects = yield* Cloudflare.R2.ReadWriteBucket(bucket);
    return Effect.fn("proof.verifySoftware")(function* (input: typeof VerifyInput.Type) {
      const base = yield* prepareSoftwareBase({
        kernelDigest: input.kernelDigest,
        artifacts: input.artifacts,
      });
      if (input.cold !== base.blocks.size || input.warm !== 0 || input.repaired !== 3)
        return yield* Effect.die({ input, expected: base.blocks.size });
      for (const [hash, bytes] of base.blocks) {
        const object = yield* objects.get(`software/blobs/${hash}`);
        if (object === null || object.size !== bytes.byteLength)
          return yield* Effect.die("Missing or wrong-sized repaired block");
        const stored = yield* object.arrayBuffer();
        if (new Bun.CryptoHasher("sha256").update(stored).digest("hex") !== hash)
          return yield* Effect.die("Wrong repaired block digest");
      }
      const manifest = yield* objects.get(`software/bases/${input.digest}.json`);
      if (manifest === null || (yield* manifest.text()) !== base.manifest)
        return yield* Effect.die("Wrong published image manifest");
      return {
        digest: input.digest,
        blocks: base.blocks.size,
        cold: input.cold,
        warm: input.warm,
        repaired: input.repaired,
      };
    });
  }).pipe(Effect.provide(Cloudflare.R2.ReadWriteBucketLocal)),
);
const ProofOutput = Schema.Struct({
  digest: Digest,
  blocks: Schema.Int,
  cold: Schema.Int,
  warm: Schema.Int,
  repaired: Schema.Int,
});
class SoftwarePublicationProof extends Alchemy.Stack<
  SoftwarePublicationProof,
  typeof ProofOutput.Type
>()("boxes-publication-proof") {}
export default SoftwarePublicationProof.make(
  { providers: Cloudflare.providers(), state: Alchemy.localState() },
  Effect.gen(function* () {
    const stage = yield* Alchemy.Stage;
    if (!(yield* Alchemy.AlchemyContext).dev || !stage.startsWith("dev_"))
      return yield* Effect.die("Publication proof requires local dev");
    const kernelDigest = new Bun.CryptoHasher("sha256")
      .update(
        yield* Effect.promise(() =>
          Bun.file(
            new URL("../../dist/kernel/cirro_kernel_bg.wasm", import.meta.url),
          ).arrayBuffer(),
        ),
      )
      .digest("hex");
    const artifacts = [defaultSoftware[7], defaultSoftware[8], defaultSoftware[9]];
    const cold = yield* softwareBase("Cold", { kernelDigest, artifacts });
    const before = yield* snapshot({ kernelDigest, artifacts, digest: cold.digest });
    const warm = yield* softwareBase("Warm", {
      kernelDigest: Output.map(before.versions, () => kernelDigest),
      artifacts,
    });
    const damaged = yield* damage({
      kernelDigest,
      artifacts,
      digest: warm.digest,
      versions: before.versions,
    });
    const repaired = yield* softwareBase("Repair", {
      kernelDigest: Output.map(damaged.removed, () => kernelDigest),
      artifacts,
    });
    return yield* verify({
      kernelDigest,
      artifacts,
      digest: repaired.digest,
      cold: cold.uploadedBlocks,
      warm: warm.uploadedBlocks,
      repaired: repaired.uploadedBlocks,
    });
  }),
);
