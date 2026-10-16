import { Effect, Schema } from "effect";
import { Id, RunRecord } from "../../src/contracts";
import type { makeBinding } from "../../src/sdk";

export const ShellCwdProof = Schema.Array(Schema.Struct({ id: Id, result: RunRecord })).check(
  Schema.isMinLength(5),
  Schema.isMaxLength(5),
);

export const shellCwdProof = Effect.fn("proof.shellCwd")(function* (
  client: Effect.Success<ReturnType<typeof makeBinding>>,
  id: string,
  command: string,
  image: string,
) {
  yield* client.action(id, {
    op: "filesystem.mkdir",
    path: "/tmp/context",
    recursive: true,
  });
  yield* client.action(id, {
    op: "filesystem.writeFiles",
    entries: [
      {
        path: "/tmp/context/script",
        content: '#!./interpreter\nprintf "%s|%s|%s\\n" "$PWD" "$0" "$1"',
        encoding: "utf8",
      },
    ],
  });
  yield* client.action(id, {
    op: "filesystem.chmod",
    path: "/tmp/context/script",
    mode: 493,
  });
  yield* client.action(id, {
    op: "filesystem.symlink",
    path: "/tmp/context/interpreter",
    target: image,
  });
  yield* client.action(id, {
    op: "filesystem.symlink",
    path: "/tmp/link",
    target: "/tmp/context",
  });
  const processes = yield* Effect.forEach(
    [
      {
        id: "direct",
        source: "cd /tmp/context; exec ./script hello",
        stdout: "/tmp/context|/tmp/context/script|hello\n",
      },
      {
        id: "absolute",
        source: `cd /tmp/context; exec ${image} -c 'printf "%s\\n" "$PWD"'`,
        stdout: "/tmp/context\n",
      },
      {
        id: "symlink",
        source: "cd /tmp/link; exec ./script hello",
        stdout: "/tmp/context|/tmp/link/script|hello\n",
      },
      {
        id: "spoofed-pwd",
        source: "cd /tmp/context; PWD=/tmp/spoof exec ./script hello",
        stdout: "/tmp/context|/tmp/context/script|hello\n",
      },
      {
        id: "empty-environment",
        source: "cd /tmp/context; exec -c ./script hello",
        stdout: "/tmp/context|/tmp/context/script|hello\n",
      },
    ],
    Effect.fn("proof.shellCwd.case")(function* (probe) {
      const result = yield* client.action(id, {
        op: "process.execFile",
        id: probe.id,
        command,
        args: ["-c", probe.source],
      });
      if (
        result.status !== "exited" ||
        result.output?.exitCode !== 0 ||
        result.output.stdout !== probe.stdout ||
        result.output.stderr !== ""
      )
        return yield* Effect.die({
          message: "Shell cwd did not survive native exec",
          probe,
          result,
        });
      return { id: probe.id, result };
    }),
  );
  return processes;
});
