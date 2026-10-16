import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Redacted } from "effect";
import { FetchHttpClient } from "effect/http";
import { makeBinding, make } from "../src/sdk";
import { runtime } from "../tooling/worker-test";

test("explicit exec cwd is canonical, independent of PWD and committed only with the image", () =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const directory = yield* Effect.acquireRelease(
          Effect.promise(() => mkdtemp(join(tmpdir(), "boxes-exec-cwd-"))),
          (directory) => Effect.promise(() => rm(directory, { recursive: true, force: true })),
        );
        const worker = yield* Effect.acquireRelease(
          Effect.sync(() => runtime(directory, { controlled: false })),
          (worker) => Effect.promise(() => worker.dispose()),
        );
        const admin = yield* make({
          url: (yield* Effect.promise(() => worker.ready)).toString(),
          token: Redacted.make("cirro-local-test-credential"),
        });
        yield* admin.create({
          id: "exec-cwd",
          policy: {
            networkHosts: [],
            interruptBudget: 10000,
            memoryBytes: 8388608,
            maxOutputBytes: 1048576,
          },
        });
        const grant = yield* admin.mintCapability("exec-cwd", {
          permissions: ["read", "write", "execute"],
          expiresInSeconds: 60,
        });
        const client = yield* makeBinding(
          yield* Effect.promise(() => worker.service),
          Redacted.make(grant.token),
        );
        yield* client.action("exec-cwd", {
          op: "filesystem.mkdir",
          path: "/tmp/context",
          recursive: true,
        });
        yield* client.action("exec-cwd", {
          op: "filesystem.mkdir",
          path: "/tmp/denied",
          recursive: true,
        });
        const source = Buffer.from(
          yield* Effect.promise(() => Bun.file("dist/wasi-exec-cwd.wasm").arrayBuffer()),
        ).toString("base64");
        yield* client.action("exec-cwd", {
          op: "filesystem.writeFiles",
          entries: [
            { path: "/tmp/context/probe.wasm", content: source, encoding: "base64" },
            { path: "/tmp/context/printer.wasm", content: source, encoding: "base64" },
            {
              path: "/tmp/context/script",
              content: "#!./printer.wasm\n",
              encoding: "utf8",
            },
            { path: "/root-script", content: "#!/tmp/context/printer.wasm\n", encoding: "utf8" },
            { path: "/tmp/context/broken", content: "not an image", encoding: "utf8" },
            {
              path: "/tmp/context/invalid.wasm",
              content: Buffer.from([0, 97, 115, 109, 1, 0, 0, 0, 1, 1, 255]).toString("base64"),
              encoding: "base64",
            },
          ],
        });
        yield* Effect.forEach(
          [
            "/tmp/context/probe.wasm",
            "/tmp/context/printer.wasm",
            "/tmp/context/script",
            "/tmp/context/broken",
            "/tmp/context/invalid.wasm",
            "/root-script",
          ],
          (path) => client.action("exec-cwd", { op: "filesystem.chmod", path, mode: 493 }),
        );
        yield* client.action("exec-cwd", {
          op: "filesystem.chmod",
          path: "/tmp/denied",
          mode: 384,
        });
        yield* client.action("exec-cwd", {
          op: "filesystem.symlink",
          path: "/tmp/link",
          target: "/tmp/context",
        });
        for (const mode of ["normal", "symlink", "fexec", "chain"]) {
          const record = yield* client.action("exec-cwd", {
            op: "process.run",
            id: mode,
            language: "wasm",
            source,
            args: [mode],
          });
          expect(record.status).toBe("exited");
          expect(record.output).toMatchObject({
            stdout: "/tmp/context|1\n",
            stderr: "",
            exitCode: 0,
          });
        }
        for (const [mode, errno] of [
          ["missing", 44],
          ["file", 54],
          ["denied", 2],
          ["relative", 28],
          ["empty", 28],
          ["nul", 28],
          ["utf8", 25],
          ["long", 28],
          ["badptr", 21],
          ["badimage", 45],
          ["invalidmodule", 45],
          ["fexec-missing", 44],
          ["fexec-relative", 28],
          ["fexec-badfd", 8],
        ] as const) {
          const record = yield* client.action("exec-cwd", {
            op: "process.run",
            id: mode,
            language: "wasm",
            source,
            args: [mode],
          });
          expect(record.status).toBe("exited");
          expect(record.output).toMatchObject({
            stdout: `errno=${errno}\n/|1\n`,
            stderr: "",
            exitCode: 0,
          });
        }
        const execute = yield* admin.mintCapability("exec-cwd", {
          permissions: ["execute"],
          expiresInSeconds: 60,
        });
        const restricted = yield* makeBinding(
          yield* Effect.promise(() => worker.service),
          Redacted.make(execute.token),
        );
        const denied = yield* restricted.action("exec-cwd", {
          op: "process.run",
          id: "read-denied",
          language: "wasm",
          source,
          args: ["normal"],
        });
        expect(denied.output).toMatchObject({ stdout: "errno=2\n", exitCode: 0, result: 2 });
        const foreign = yield* restricted
          .action("exec-cwd-other", {
            op: "process.run",
            id: "foreign",
            language: "wasm",
            source,
            args: ["normal"],
          })
          .pipe(Effect.result);
        expect(foreign).toMatchObject({
          _tag: "Failure",
          failure: { _tag: "BoxesError", status: 401 },
        });
      }),
    ).pipe(Effect.provide(FetchHttpClient.layer)),
  ));
