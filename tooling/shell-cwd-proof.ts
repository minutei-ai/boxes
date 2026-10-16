import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Redacted, Schema } from "effect";
import { FetchHttpClient } from "effect/http";
import { Id, RunRecord } from "../src/contracts";
import { make, makeBinding } from "../src/sdk";
import { runtime } from "./worker-test";

const Report = Schema.Struct({
  shellSha256: Schema.String,
  wasiRuntimeSha256: Schema.String,
  transport: Schema.Literal("native Alchemy workerd Agent service binding and local R2"),
  processes: Schema.Array(Schema.Struct({ id: Id, result: RunRecord })),
});
const [path] = Schema.decodeUnknownSync(Schema.Tuple([Schema.String.check(Schema.isMinLength(1))]))(
  Bun.argv.slice(2),
);
const proof = await Effect.runPromise(
  Effect.scoped(
    Effect.gen(function* () {
      const bytes = yield* Effect.promise(() => Bun.file(path).bytes());
      const shellSha256 = Buffer.from(
        yield* Effect.promise(() => crypto.subtle.digest("SHA-256", bytes)),
      ).toString("hex");
      const wasiRuntime = yield* Effect.promise(() =>
        Bun.file("dist/worker/cirro_wasi_bg.wasm").bytes(),
      );
      const wasiRuntimeSha256 = Buffer.from(
        yield* Effect.promise(() => crypto.subtle.digest("SHA-256", wasiRuntime)),
      ).toString("hex");
      const directory = yield* Effect.acquireRelease(
        Effect.promise(() => mkdtemp(join(tmpdir(), "boxes-shell-cwd-proof-"))),
        (path) => Effect.promise(() => rm(path, { recursive: true, force: true })),
      );
      const worker = yield* Effect.acquireRelease(
        Effect.sync(() => runtime(directory, { controlled: false })),
        (worker) => Effect.promise(() => worker.dispose()),
      );
      const admin = yield* make({
        url: (yield* Effect.promise(() => worker.ready)).toString(),
        token: Redacted.make("cirro-local-test-credential"),
      });
      const id = "shell-cwd-proof";
      yield* admin.create({
        id,
        policy: {
          networkHosts: [],
          interruptBudget: 100000,
          memoryBytes: 8388608,
          maxOutputBytes: 1048576,
        },
      });
      const grant = yield* admin.mintCapability(id, {
        permissions: ["read", "write", "execute"],
        expiresInSeconds: 600,
      });
      const client = yield* makeBinding(
        yield* Effect.promise(() => worker.service),
        Redacted.make(grant.token),
      );
      yield* client.action(id, {
        op: "filesystem.mkdir",
        path: "/tmp/context",
        recursive: true,
      });
      yield* client.action(id, {
        op: "filesystem.writeFiles",
        entries: [
          {
            path: "/tmp/boxes-sh.wasm",
            content: Buffer.from(bytes).toString("base64"),
            encoding: "base64",
          },
          {
            path: "/tmp/context/script",
            content: '#!./interpreter\nprintf "%s|%s|%s\\n" "$PWD" "$0" "$1"',
            encoding: "utf8",
          },
        ],
      });
      yield* Effect.forEach(["/tmp/boxes-sh.wasm", "/tmp/context/script"], (path) =>
        client.action(id, { op: "filesystem.chmod", path, mode: 493 }),
      );
      yield* client.action(id, {
        op: "filesystem.symlink",
        path: "/tmp/context/interpreter",
        target: "/tmp/boxes-sh.wasm",
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
            source: 'cd /tmp/context; exec /tmp/boxes-sh.wasm -c \'printf "%s\\n" "$PWD"\'',
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
            command: "/tmp/boxes-sh.wasm",
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
      return {
        shellSha256,
        wasiRuntimeSha256,
        transport: "native Alchemy workerd Agent service binding and local R2" as const,
        processes,
      };
    }),
  ).pipe(Effect.provide(FetchHttpClient.layer)),
);
console.log(Schema.encodeSync(Schema.fromJsonString(Report))(proof));
