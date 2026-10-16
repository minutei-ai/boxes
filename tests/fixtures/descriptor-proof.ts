import { Effect, Schema } from "effect";
import { FileContent, RunRecord } from "../../src/contracts";
import type { makeBinding } from "../../src/sdk";

export const descriptorCases = [
  { mode: "fexec", stdout: "/dev/fd/12|fexec|blue\n", result: null, file: "fexec" },
  { mode: "fexec-unlink", stdout: "/dev/fd/12|fexec|blue\n", result: null, file: "fexec-unlink" },
  { mode: "fexec-rename", stdout: "/dev/fd/12|fexec|blue\n", result: null, file: "fexec-rename" },
  { mode: "fexec-cloexec", stdout: "", result: 44, file: "fexec-rename" },
  { mode: "fexec-closed", stdout: "", result: 44, file: "fexec-rename" },
];

export const DescriptorProof = Schema.Array(
  Schema.Struct({ run: RunRecord, file: FileContent }),
).check(
  Schema.isMinLength(descriptorCases.length),
  Schema.isMaxLength(descriptorCases.length),
  Schema.makeFilter((entries) =>
    entries.every((entry, index) => {
      const probe = descriptorCases[index];
      return (
        entry.run.id === `descriptor-${probe?.mode}` &&
        entry.run.status === "exited" &&
        entry.run.output?.exitCode === 0 &&
        entry.run.output.stdout === probe?.stdout &&
        entry.run.output.stderr === "" &&
        entry.run.output.result === probe?.result &&
        Buffer.from(entry.file.content, entry.file.encoding).toString("utf8") === probe?.file
      );
    }),
  ),
);

export const descriptorProof = Effect.fn("fixtures.descriptorProof")(function* (
  client: Effect.Success<ReturnType<typeof makeBinding>>,
  sandboxId: string,
) {
  yield* client.action(sandboxId, {
    op: "filesystem.writeFile",
    path: "/tmp/data",
    content: "ABC",
    encoding: "utf8",
  });
  const entries = yield* Effect.forEach(descriptorCases, (probe) =>
    Effect.gen(function* () {
      yield* client.action(sandboxId, {
        op: "filesystem.writeFile",
        path: "/tmp/next.wasm",
        content: `#!/opt/cirro/bin/sh\nprintf "%s|%s|%s\\n" "$0" "$1" "$COLOR"; printf "%s" "${probe.mode}" > /tmp/from-descriptor`,
        encoding: "utf8",
      });
      yield* client.action(sandboxId, {
        op: "filesystem.chmod",
        path: "/tmp/next.wasm",
        mode: 493,
      });
      const source = yield* client.action(sandboxId, {
        op: "filesystem.readFile",
        path: `/tmp/driver-${probe.mode}.wasm`,
      });
      const run = yield* client.action(sandboxId, {
        op: "process.run",
        id: `descriptor-${probe.mode}`,
        language: "wasm",
        source: source.content,
      });
      const file = yield* client.action(sandboxId, {
        op: "filesystem.readFile",
        path: "/tmp/from-descriptor",
      });
      return { run, file };
    }),
  );
  if (!Schema.is(DescriptorProof)(entries)) return yield* Effect.die(entries);
  return entries;
});
