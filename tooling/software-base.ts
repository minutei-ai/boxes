import { Effect, Schema } from "effect";
import { initSync, Kernel } from "../dist/kernel/cirro_kernel";
import { Digest, PackageInstallation } from "../src/contracts";
import { SoftwareArtifact } from "../src/default-software";
import { kernelCall } from "../src/storage";
import { downloadSoftware } from "./software-artifacts";

export const SoftwareBaseInput = Schema.Struct({
  kernelDigest: Digest,
  artifacts: Schema.Array(SoftwareArtifact).check(Schema.isMinLength(1), Schema.isMaxLength(16)),
});
class SoftwareBaseFailure extends Schema.TaggedError<SoftwareBaseFailure>()("SoftwareBaseFailure", {
  message: Schema.String,
}) {}

export const prepareSoftwareBase = Effect.fn("software.prepareBase")(function* (
  input: typeof SoftwareBaseInput.Type,
) {
  const configured = yield* Schema.decodeUnknownEffect(SoftwareBaseInput, {
    onExcessProperty: "error",
  })(input);
  const bytes = yield* Effect.promise(() =>
    Bun.file(new URL("../dist/kernel/cirro_kernel_bg.wasm", import.meta.url)).arrayBuffer(),
  );
  const kernelDigest = new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
  if (kernelDigest !== configured.kernelDigest)
    return yield* new SoftwareBaseFailure({ message: "Kernel changed after software planning" });
  yield* Effect.try(() => initSync({ module: new WebAssembly.Module(bytes) }));
  const kernel = yield* Effect.acquireRelease(
    kernelCall(() => new Kernel()),
    (kernel) => Effect.sync(() => kernel.free()),
  );
  const blocks = new Map<string, Uint8Array>();
  for (const artifact of configured.artifacts) {
    const bytes = yield* downloadSoftware(artifact);
    const installed = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(PackageInstallation))(
      yield* kernelCall(() => kernel.install_image_package(bytes)),
    );
    if (installed.installed.manifest.name !== artifact.name)
      return yield* new SoftwareBaseFailure({ message: "Package name does not match the catalog" });
    for (const block of installed.blocks)
      blocks.set(block.hash, bytes.subarray(block.offset, block.offset + block.length));
  }
  const manifest = yield* kernelCall(() => kernel.manifest());
  const digest = new Bun.CryptoHasher("sha256").update(manifest).digest("hex");
  return { manifest, digest, blocks };
}, Effect.scoped);
