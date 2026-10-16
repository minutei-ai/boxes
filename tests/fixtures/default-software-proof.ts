import { Effect, Schema, Struct } from "effect";
import { AgentRequest, Digest, Id, RunRecord, SoftwareCatalog } from "../../src/contracts";
import type { makeBinding } from "../../src/sdk";

const SoftwareProbe = Schema.Struct({
  id: Schema.String,
  command: Schema.String,
  args: Schema.Array(Schema.String),
  stdin: Schema.String,
  stdout: Schema.String,
  exitCode: Schema.Int,
});
export const defaultSoftwareCases = Schema.decodeUnknownSync(Schema.Array(SoftwareProbe))([
  {
    id: "coreutils",
    command: "printf",
    args: ["%s:%s\\n", "native", "image"],
    stdin: "",
    stdout: "native:image\n",
    exitCode: 0,
  },
  {
    id: "bracket",
    command: "[",
    args: ["42", "-eq", "42", "]"],
    stdin: "",
    stdout: "",
    exitCode: 0,
  },
  {
    id: "bracket-false",
    command: "[",
    args: ["42", "-eq", "43", "]"],
    stdin: "",
    stdout: "",
    exitCode: 1,
  },
  {
    id: "sed",
    command: "sed",
    args: ["s/old/new/g"],
    stdin: "old old\n",
    stdout: "new new\n",
    exitCode: 0,
  },
  {
    id: "grep",
    command: "grep",
    args: ["needle"],
    stdin: "hay\nneedle\n",
    stdout: "needle\n",
    exitCode: 0,
  },
  {
    id: "gawk",
    command: "awk",
    args: ["{ sum += $1 } END { print sum }"],
    stdin: "5\n7\n",
    stdout: "12\n",
    exitCode: 0,
  },
  {
    id: "findutils",
    command: "find",
    args: ["/tmp", "-name", "seed.txt"],
    stdin: "",
    stdout: "/tmp/seed.txt\n",
    exitCode: 0,
  },
  {
    id: "diffutils",
    command: "diff",
    args: ["/tmp/a", "/tmp/b"],
    stdin: "",
    stdout: "1c1\n< alpha\n---\n> beta\n",
    exitCode: 1,
  },
  {
    id: "tar-write",
    command: "tar",
    args: ["-cf", "/tmp/probe.tar", "-C", "/tmp", "seed.txt"],
    stdin: "",
    stdout: "",
    exitCode: 0,
  },
  {
    id: "tar-read",
    command: "tar",
    args: ["-tf", "/tmp/probe.tar"],
    stdin: "",
    stdout: "seed.txt\n",
    exitCode: 0,
  },
  {
    id: "gzip-write",
    command: "gzip",
    args: ["-k", "/tmp/compress"],
    stdin: "",
    stdout: "",
    exitCode: 0,
  },
  {
    id: "gzip-read",
    command: "gzip",
    args: ["-d", "-c", "/tmp/compress.gz"],
    stdin: "",
    stdout: "compressed content\n",
    exitCode: 0,
  },
  {
    id: "jq",
    command: "jq",
    args: [".value + 1"],
    stdin: '{"value":41}\n',
    stdout: "42\n",
    exitCode: 0,
  },
  {
    id: "sh",
    command: "sh",
    args: ["-c", "printf 'shell-ready\\n'"],
    stdin: "",
    stdout: "shell-ready\n",
    exitCode: 0,
  },
]);

export const DefaultSoftwareProofInput = AgentRequest.mapFields((fields) => ({
  ...Struct.pick(fields, ["sandboxId", "token"]),
  packageDigests: Schema.Array(Digest).check(Schema.isMinLength(1), Schema.isMaxLength(16)),
}));
export const DefaultSoftwareProof = Schema.Struct({
  catalog: SoftwareCatalog,
  runs: Schema.Array(RunRecord).check(
    Schema.isMinLength(defaultSoftwareCases.length),
    Schema.isMaxLength(defaultSoftwareCases.length),
  ),
}).check(
  Schema.makeFilter((proof) =>
    proof.runs.every((run, index) => {
      const probe = defaultSoftwareCases[index];
      if (probe === undefined || run.output === null) return false;
      return (
        run.id === probe.id &&
        run.status === "exited" &&
        run.output.stdout === probe.stdout &&
        run.output.stderr === "" &&
        run.output.exitCode === probe.exitCode
      );
    }),
  ),
);

export const defaultSoftwareProof = Effect.fn("proof.defaultSoftware")(function* (
  client: Effect.Success<ReturnType<typeof makeBinding>>,
  sandboxId: typeof Id.Type,
  packageDigests: typeof DefaultSoftwareProofInput.fields.packageDigests.Type,
) {
  const catalog = yield* client.action(sandboxId, { op: "software.list" });
  if (
    catalog.length !== packageDigests.length ||
    packageDigests.some((digest) => !catalog.some((installed) => installed.packageId === digest))
  )
    return yield* Effect.die({ message: "Default catalog mismatch", catalog });
  yield* Effect.forEach(
    [
      { path: "/tmp/seed.txt", content: "seed\n" },
      { path: "/tmp/a", content: "alpha\n" },
      { path: "/tmp/b", content: "beta\n" },
      { path: "/tmp/compress", content: "compressed content\n" },
    ],
    (file) => client.action(sandboxId, { op: "filesystem.writeFile", ...file, encoding: "utf8" }),
    { concurrency: 1, discard: true },
  );
  const runs = yield* Effect.forEach(
    defaultSoftwareCases,
    Effect.fn("proof.defaultSoftware.case")(function* (probe) {
      yield* Effect.logInfo({ phase: "software.probe", id: probe.id });
      const result = yield* client.action(sandboxId, {
        op: "process.execFile",
        id: probe.id,
        command: `/opt/cirro/bin/${probe.command}`,
        args: probe.args,
        stdin: { content: probe.stdin, encoding: "utf8" },
      });
      if (result.output === null || result.status !== "exited")
        return yield* Effect.die({ probe, result });
      if (
        result.output.stdout !== probe.stdout ||
        result.output.exitCode !== probe.exitCode ||
        result.output.stderr !== ""
      )
        return yield* Effect.die({ probe, result });
      return result;
    }),
  );
  return { catalog, runs };
});
