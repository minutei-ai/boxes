import { Schema } from "effect";
import { Digest } from "./contracts";

export const SoftwareArtifact = Schema.Struct({
  name: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128)),
  digest: Digest,
  size: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 16_777_216 })),
  url: Schema.String.check(Schema.isPattern(/^https:\/\//), Schema.isMaxLength(4096)),
});
export const SoftwareBaseDigest = Schema.NullOr(Digest);
export const defaultSoftware = [
  {
    name: "sh",
    digest: "1922d7987e34c080abe1c8edf85e0d01c4f5dccaefafe1dada5735c6e64eb2ec",
    size: 4349290,
    url: "https://github.com/minutei-ai/boxes/releases/download/sdk-v0.17.0/sh-0.17.0.aospkg",
  },
  {
    name: "jq",
    digest: "edb1cf0bbcf663d177916592d2f1b4361a02966dbf2eb44e3e61ea2a399bb43a",
    size: 716972,
    url: "https://releases.rivet.dev/agent-os/latest/software/packages/jq/edb1cf0bbcf663d177916592d2f1b4361a02966dbf2eb44e3e61ea2a399bb43a.aospkg",
  },
] as const satisfies ReadonlyArray<typeof SoftwareArtifact.Type>;
