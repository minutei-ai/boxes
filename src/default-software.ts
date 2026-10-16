import { Schema } from "effect";
import { Digest } from "./contracts";

export const SoftwareArtifact = Schema.Struct({
  name: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128)),
  digest: Digest,
  size: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 134_217_728 })),
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
  {
    name: "coreutils",
    digest: "4bee17be5e65fab4195ab794e0a175021738c8fbe4363312b6987b57ec4b395d",
    size: 67400857,
    url: "https://releases.rivet.dev/agent-os/latest/software/packages/coreutils/4bee17be5e65fab4195ab794e0a175021738c8fbe4363312b6987b57ec4b395d.aospkg",
  },
  {
    name: "sed",
    digest: "627c66cd792dbf7d8be470957f8fabb601480f10bb8e4688f01125e174c3b94a",
    size: 1268400,
    url: "https://releases.rivet.dev/agent-os/latest/software/packages/sed/627c66cd792dbf7d8be470957f8fabb601480f10bb8e4688f01125e174c3b94a.aospkg",
  },
  {
    name: "grep",
    digest: "7cfda6adf263ab53a82d6615889be50b7378ec763105a44b7791d1ad07df3d86",
    size: 425270,
    url: "https://releases.rivet.dev/agent-os/latest/software/packages/grep/7cfda6adf263ab53a82d6615889be50b7378ec763105a44b7791d1ad07df3d86.aospkg",
  },
  {
    name: "gawk",
    digest: "a448662d870f46b78a091b1bff689697d47c5e535ece11042e9394ed64305716",
    size: 1186481,
    url: "https://releases.rivet.dev/agent-os/latest/software/packages/gawk/a448662d870f46b78a091b1bff689697d47c5e535ece11042e9394ed64305716.aospkg",
  },
  {
    name: "findutils",
    digest: "a76c3acfd9124669f8476f6d5acb8799b8606b126518f05c4d508e144898036a",
    size: 1783546,
    url: "https://releases.rivet.dev/agent-os/latest/software/packages/findutils/a76c3acfd9124669f8476f6d5acb8799b8606b126518f05c4d508e144898036a.aospkg",
  },
  {
    name: "diffutils",
    digest: "c63f665fb9e8eb7cae4162d9d58f496d931d0e55c6d9e3aa6c1a841412a781e1",
    size: 140985,
    url: "https://releases.rivet.dev/agent-os/latest/software/packages/diffutils/c63f665fb9e8eb7cae4162d9d58f496d931d0e55c6d9e3aa6c1a841412a781e1.aospkg",
  },
  {
    name: "tar",
    digest: "a1db07c4e8113f1acb65651f470d362a87f4a18ba346c553c418c151f1e4e9f9",
    size: 220336,
    url: "https://releases.rivet.dev/agent-os/latest/software/packages/tar/a1db07c4e8113f1acb65651f470d362a87f4a18ba346c553c418c151f1e4e9f9.aospkg",
  },
  {
    name: "gzip",
    digest: "76edafcb28727c6efe36ef73b74b3c14fbc16fa5962c706b163266c39c347597",
    size: 413494,
    url: "https://releases.rivet.dev/agent-os/latest/software/packages/gzip/76edafcb28727c6efe36ef73b74b3c14fbc16fa5962c706b163266c39c347597.aospkg",
  },
] as const satisfies ReadonlyArray<typeof SoftwareArtifact.Type>;
