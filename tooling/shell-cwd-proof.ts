import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Redacted, Schema } from "effect";
import { FetchHttpClient } from "effect/http";
import { Id, RunRecord } from "../src/contracts";
import { make, makeBinding } from "../src/sdk";
import { runtime } from "./worker-test";

const Report = Schema.Struct({
  artifactFormat: Schema.Literals(["wasm", "aospkg"]),
  artifactSha256: Schema.String,
  shellSha256: Schema.String,
  notices: Schema.Array(
    Schema.Struct({ path: Schema.String, sha256: Schema.String, bytes: Schema.Int }),
  ),
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
      const artifactSha256 = Buffer.from(
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
        permissions: ["read", "write", "execute", "manage"],
        expiresInSeconds: 600,
      });
      const client = yield* makeBinding(
        yield* Effect.promise(() => worker.service),
        Redacted.make(grant.token),
      );
      const artifact = yield* Effect.gen(function* () {
        if (Buffer.from(bytes.subarray(0, 8)).equals(Buffer.from("\0asm\x01\0\0\0"))) {
          yield* client.action(id, {
            op: "filesystem.writeFile",
            path: "/tmp/boxes-sh.wasm",
            content: Buffer.from(bytes).toString("base64"),
            encoding: "base64",
          });
          yield* client.action(id, {
            op: "filesystem.chmod",
            path: "/tmp/boxes-sh.wasm",
            mode: 493,
          });
          return {
            format: "wasm" as const,
            command: "/tmp/boxes-sh.wasm",
            image: "/tmp/boxes-sh.wasm",
            shellSha256: artifactSha256,
            notices: [],
          };
        }
        if (!Buffer.from(bytes.subarray(0, 8)).equals(Buffer.from("\x89AOS\x02\0\0\0", "latin1")))
          return yield* Effect.die("Expected a Wasm v1 image or a v2 aospkg");
        yield* client.action(id, {
          op: "filesystem.writeFile",
          path: "/tmp/shell.aospkg",
          content: Buffer.from(bytes).toString("base64"),
          encoding: "base64",
        });
        const installed = yield* client.action(id, {
          op: "software.install",
          source: { path: "/tmp/shell.aospkg", digest: `sha256:${artifactSha256}` },
        });
        if (installed.manifest.name !== "sh" || installed.digest !== `sha256:${artifactSha256}`)
          return yield* Effect.die("Installed shell identity does not match its artifact");
        const binary = yield* client.action(id, {
          op: "filesystem.readFile",
          path: "/opt/cirro/bin/sh",
        });
        const shellSha256 = Buffer.from(
          yield* Effect.promise(() =>
            crypto.subtle.digest("SHA-256", Buffer.from(binary.content, "base64")),
          ),
        ).toString("hex");
        const noticeRoot = `/opt/cirro/pkgs/sh/${installed.manifest.version}/share/boxes-sh`;
        const entries = yield* client.action(id, {
          op: "filesystem.readdirRecursive",
          path: noticeRoot,
          maxDepth: 16,
        });
        if (!entries.some((entry) => entry.path === `${noticeRoot}/NOTICE` && entry.size > 0))
          return yield* Effect.die("Installed shell has no NOTICE");
        const notices = yield* Effect.forEach(
          entries.filter((entry) => entry.type === "file"),
          Effect.fn("proof.shellCwd.notice")(function* (entry) {
            const file = yield* client.action(id, {
              op: "filesystem.readFile",
              path: entry.path,
            });
            const content = Buffer.from(file.content, "base64");
            return {
              path: entry.path.slice(noticeRoot.length + 1),
              sha256: Buffer.from(
                yield* Effect.promise(() => crypto.subtle.digest("SHA-256", content)),
              ).toString("hex"),
              bytes: content.length,
            };
          }),
        );
        return {
          format: "aospkg" as const,
          command: "sh",
          image: "/opt/cirro/bin/sh",
          shellSha256,
          notices,
        };
      });
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
        target: artifact.image,
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
            source: `cd /tmp/context; exec ${artifact.image} -c 'printf "%s\\n" "$PWD"'`,
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
            command: artifact.command,
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
        artifactFormat: artifact.format,
        artifactSha256,
        shellSha256: artifact.shellSha256,
        notices: artifact.notices,
        wasiRuntimeSha256,
        transport: "native Alchemy workerd Agent service binding and local R2" as const,
        processes,
      };
    }),
  ).pipe(Effect.provide(FetchHttpClient.layer)),
);
console.log(Schema.encodeSync(Schema.fromJsonString(Report))(proof));
