import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Redacted, Schema } from "effect";
import { FetchHttpClient } from "effect/http";
import { ShellCwdProof, shellCwdProof } from "../tests/fixtures/shell-cwd-proof";
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
  transport: Schema.Literal("native Alchemy workerd service binding and local R2"),
  processes: ShellCwdProof,
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
      const processes = yield* shellCwdProof(client, id, artifact.command, artifact.image);
      return {
        artifactFormat: artifact.format,
        artifactSha256,
        shellSha256: artifact.shellSha256,
        notices: artifact.notices,
        wasiRuntimeSha256,
        transport: "native Alchemy workerd service binding and local R2" as const,
        processes,
      };
    }),
  ).pipe(Effect.provide(FetchHttpClient.layer)),
);
console.log(Schema.encodeSync(Schema.fromJsonString(Report))(proof));
