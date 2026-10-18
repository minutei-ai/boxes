import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Redacted } from "effect";
import { makeBinding } from "../src/sdk";
import { runtime } from "../tooling/worker-test";

const connect = Effect.fn("semanticPathsTest.connect")(function* (directory: string) {
  const worker = yield* Effect.acquireRelease(
    Effect.sync(() => runtime(directory, { controlled: false })),
    (worker) => Effect.promise(() => worker.dispose()),
  );
  const service = yield* Effect.promise(() => worker.service);
  return {
    service,
    admin: yield* makeBinding(service, Redacted.make("cirro-local-test-credential")),
  };
});

test(
  "semantic parent components preserve native filesystem identity across APIs and closed Workers",
  () =>
    Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const directory = yield* Effect.acquireRelease(
            Effect.promise(() => mkdtemp(join(tmpdir(), "boxes-semantic-paths-"))),
            (path) => Effect.promise(() => rm(path, { recursive: true, force: true })),
          );
          const token = yield* Effect.scoped(
            Effect.gen(function* () {
              const native = yield* connect(directory);
              yield* native.admin.create({
                id: "semantic",
                policy: {
                  networkHosts: [],
                  interruptBudget: 100000,
                  memoryBytes: 16777216,
                  maxOutputBytes: 1048576,
                },
              });
              const grant = yield* native.admin.mintCapability("semantic", {
                permissions: ["read", "write", "execute", "manage"],
                expiresInSeconds: 3600,
              });
              const client = yield* makeBinding(native.service, Redacted.make(grant.token));
              yield* client.action("semantic", {
                op: "filesystem.mkdir",
                path: "/tmp/real/deep",
                recursive: true,
              });
              yield* client.action("semantic", {
                op: "filesystem.mkdir",
                path: "/tmp/scoped",
                recursive: false,
              });
              yield* client.action("semantic", {
                op: "filesystem.mkdir",
                path: "/home/cirro/secret-dir",
                recursive: false,
              });
              for (const [path, content] of [
                ["/home/cirro/marker", "wrong"],
                ["/tmp/real/marker", "right"],
                ["/tmp/scoped/marker", "scoped"],
                ["/tmp/real/value.mjs", "export const value=42;"],
                ["/home/cirro/value.mjs", "export const value=13;"],
                ["/tmp/real/entry.mjs", "console.log(42);"],
              ])
                yield* client.action("semantic", {
                  op: "filesystem.writeFile",
                  path,
                  content,
                  encoding: "utf8",
                });
              yield* client.action("semantic", {
                op: "filesystem.symlink",
                path: "/home/cirro/alias",
                target: "/tmp/real/deep",
              });
              yield* client.action("semantic", {
                op: "filesystem.symlink",
                path: "/tmp/scoped/outside",
                target: "/home/cirro/secret-dir",
              });
              const content = yield* client.action("semantic", {
                op: "filesystem.readFile",
                path: "/home/cirro/alias/../marker",
              });
              expect(Buffer.from(content.content, "base64").toString()).toBe("right");
              const direct = yield* client.action("semantic", {
                op: "filesystem.stat",
                path: "/tmp/real/marker",
                follow: true,
              });
              const alias = yield* client.action("semantic", {
                op: "filesystem.stat",
                path: "/home/cirro/alias/../marker",
                follow: true,
              });
              expect(alias.inode).toBe(direct.inode);
              const writes = yield* client.action("semantic", {
                op: "filesystem.writeFiles",
                entries: [
                  {
                    path: "/home/cirro/alias/../batch/nested/value",
                    content: "batch",
                    encoding: "utf8",
                  },
                ],
              });
              expect(writes[0]?.success).toBe(true);
              expect(
                Buffer.from(
                  (yield* client.action("semantic", {
                    op: "filesystem.readFile",
                    path: "/tmp/real/batch/nested/value",
                  })).content,
                  "base64",
                ).toString(),
              ).toBe("batch");
              const tree = yield* client.action("semantic", {
                op: "filesystem.readdirRecursive",
                path: "/home/cirro/alias/../batch",
              });
              expect(tree.map((entry) => entry.path)).toEqual([
                "/home/cirro/alias/../batch/nested",
                "/home/cirro/alias/../batch/nested/value",
              ]);
              for (const entry of tree)
                expect(
                  (yield* client.action("semantic", {
                    op: "filesystem.stat",
                    path: entry.path,
                    follow: true,
                  })).kind,
                ).toBe(entry.type);
              const shell = yield* client.action("semantic", {
                op: "process.run",
                id: "shell",
                language: "shell",
                source: "cat /home/cirro/alias/../marker",
              });
              expect(shell.output?.stdout).toBe("right");
              expect(shell.output?.exitCode).toBe(0);
              const module = yield* client.action("semantic", {
                op: "javascript.execute",
                id: "module",
                filePath: "/home/cirro/main.mjs",
                source: "import {value} from './alias/../value.mjs'; console.log(value);",
              });
              expect(module.output?.stderr).toBe("");
              expect(module.output?.stdout).toBe("13\n");
              const entry = yield* client.action("semantic", {
                op: "javascript.executeFile",
                id: "entry",
                path: "/home/cirro/alias/../entry.mjs",
              });
              expect(entry.output?.stderr).toBe("");
              expect(entry.output?.stdout).toBe("42\n");
              const python = yield* client.action("semantic", {
                op: "python.execute",
                id: "python",
                source:
                  "import os\nwith open('/home/cirro/alias/../marker') as stream:\n assert stream.read()=='right'\nassert os.path.realpath('/home/cirro/alias/../marker',strict=True)=='/tmp/real/marker'\nTrue",
              });
              expect(python.output?.stderr).toBe("");
              expect(python.output?.result).toBe(true);
              const source = Buffer.from(
                yield* Effect.promise(() =>
                  Bun.file(new URL("../dist/wasi-paths.wasm", import.meta.url)).arrayBuffer(),
                ),
              ).toString("base64");
              const wasi = yield* client.action("semantic", {
                op: "process.run",
                id: "wasi",
                language: "wasm",
                source,
                args: ["semantic-paths"],
              });
              expect(wasi.output?.stderr).toBe("");
              expect(wasi.output?.stdout).toBe("semantic paths verified\n");
              expect(wasi.output?.exitCode).toBe(0);
              for (const [path, code] of [
                ["/tmp/missing/..", "ENOENT"],
                ["/home/cirro/marker/..", "ENOTDIR"],
                ["/home/cirro/marker/", "ENOTDIR"],
              ]) {
                const result = yield* client
                  .action("semantic", { op: "filesystem.stat", path, follow: true })
                  .pipe(Effect.result);
                expect(result._tag).toBe("Failure");
                if (result._tag === "Failure") {
                  expect(result.failure._tag).toBe("BoxesError");
                  if (result.failure._tag === "BoxesError") expect(result.failure.error).toBe(code);
                }
              }
              const unlink = yield* client
                .action("semantic", {
                  op: "filesystem.remove",
                  path: "/home/cirro/alias/",
                  recursive: true,
                })
                .pipe(Effect.result);
              expect(unlink._tag).toBe("Failure");
              if (unlink._tag === "Failure") {
                expect(unlink.failure._tag).toBe("BoxesError");
                if (unlink.failure._tag === "BoxesError")
                  expect(unlink.failure.error).toBe("ENOTDIR");
              }
              expect(
                (yield* client.action("semantic", {
                  op: "filesystem.stat",
                  path: "/tmp/real/deep",
                  follow: true,
                })).kind,
              ).toBe("directory");
              yield* client.action("semantic", {
                op: "filesystem.move",
                from: "/home/cirro/alias/../from-wasi",
                to: "/home/cirro/alias/../renamed",
              });
              return grant.token;
            }),
          );
          const native = yield* connect(directory);
          const client = yield* makeBinding(native.service, Redacted.make(token));
          expect(
            Buffer.from(
              (yield* client.action("semantic", {
                op: "filesystem.readFile",
                path: "/home/cirro/alias/../renamed",
              })).content,
              "base64",
            ).toString(),
          ).toBe("wasi");
          yield* client.action("semantic", {
            op: "filesystem.remove",
            path: "/home/cirro/alias/../renamed",
            recursive: false,
          });
          expect(
            (yield* client.action("semantic", {
              op: "filesystem.exists",
              path: "/tmp/real/renamed",
            })).exists,
          ).toBe(false);
          expect(
            Buffer.from(
              (yield* client.action("semantic", {
                op: "filesystem.readFile",
                path: "/home/cirro/marker",
              })).content,
              "base64",
            ).toString(),
          ).toBe("wrong");
        }),
      ),
    ),
  60000,
);
