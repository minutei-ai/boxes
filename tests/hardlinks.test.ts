import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Redacted, Schema } from "effect";
import { FetchHttpClient } from "effect/http";
import { make } from "../src/sdk";
import { FilesystemSnapshot } from "../src/contracts";
import { runtime } from "../tooling/worker-test";

test(
  "hard links preserve bytes, authority and snapshot identity through Worker replacement",
  () =>
    Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const directory = yield* Effect.acquireRelease(
            Effect.promise(() => mkdtemp(join(tmpdir(), "boxes-hardlinks-"))),
            (path) => Effect.promise(() => rm(path, { recursive: true, force: true })),
          );
          const retained = yield* Effect.scoped(
            Effect.gen(function* () {
              const worker = yield* Effect.acquireRelease(
                Effect.sync(() => runtime(directory)),
                (worker) => Effect.promise(() => worker.dispose()),
              );
              const url = (yield* Effect.promise(() => worker.ready)).toString();
              const admin = yield* make({
                url,
                token: Redacted.make("cirro-local-test-credential"),
              });
              yield* admin.create({
                id: "links",
                policy: {
                  networkHosts: [],
                  interruptBudget: 1000,
                  memoryBytes: 8388608,
                  maxOutputBytes: 1048576,
                },
              });
              const grant = yield* admin.mintCapability("links", {
                permissions: ["read", "write", "execute", "manage"],
                expiresInSeconds: 600,
              });
              const client = yield* make({ url, token: Redacted.make(grant.token) });
              const bytes = Buffer.from([0, 255, 128, 10, 65, 0]);
              yield* client.action("links", {
                op: "filesystem.writeFile",
                path: "/tmp/source",
                content: bytes.toString("base64"),
                encoding: "base64",
              });
              yield* client.action("links", {
                op: "filesystem.link",
                from: "/tmp/source",
                to: "/tmp/alias",
                follow: false,
              });
              const source = yield* client.action("links", {
                op: "filesystem.stat",
                path: "/tmp/source",
                follow: true,
              });
              expect(
                yield* client.action("links", {
                  op: "filesystem.stat",
                  path: "/tmp/alias",
                  follow: true,
                }),
              ).toMatchObject({ inode: source.inode, nlink: 2 });
              expect((yield* client.action("links", { op: "vm.status" })).filesystemBytes).toBe(
                bytes.length,
              );
              yield* client.action("links", {
                op: "filesystem.chown",
                path: "/tmp/alias",
                uid: 123,
                gid: 456,
                follow: false,
              });
              yield* client.action("links", {
                op: "filesystem.writeFile",
                path: "/tmp/alias",
                content: "!",
                encoding: "utf8",
                offset: bytes.length,
              });
              expect(
                (yield* client.action("links", { op: "filesystem.readFile", path: "/tmp/source" }))
                  .content,
              ).toBe(Buffer.concat([bytes, Buffer.from("!")]).toString("base64"));
              yield* client.action("links", {
                op: "filesystem.symlink",
                path: "/tmp/symbolic",
                target: "missing",
              });
              yield* client.action("links", {
                op: "filesystem.link",
                from: "/tmp/symbolic",
                to: "/tmp/symbolic-alias",
                follow: false,
              });
              const missing = yield* client
                .action("links", {
                  op: "filesystem.link",
                  from: "/tmp/symbolic",
                  to: "/tmp/followed",
                  follow: true,
                })
                .pipe(Effect.result);
              expect(missing._tag).toBe("Failure");
              const readonly = yield* admin.mintCapability("links", {
                permissions: ["read", "execute"],
                expiresInSeconds: 600,
              });
              const reader = yield* make({ url, token: Redacted.make(readonly.token) });
              const denied = yield* reader
                .action("links", {
                  op: "filesystem.link",
                  from: "/tmp/source",
                  to: "/tmp/denied",
                  follow: false,
                })
                .pipe(Effect.result);
              expect(denied._tag).toBe("Failure");
              if (denied._tag === "Failure") expect(denied.failure).toMatchObject({ status: 403 });
              expect(
                yield* client.action("links", { op: "filesystem.exists", path: "/tmp/denied" }),
              ).toEqual({ exists: false });
              const writerGrant = yield* admin.mintCapability("links", {
                permissions: ["write"],
                expiresInSeconds: 600,
              });
              const writer = yield* make({ url, token: Redacted.make(writerGrant.token) });
              yield* writer.action("links", {
                op: "filesystem.link",
                from: "/tmp/source",
                to: "/tmp/write-only",
                follow: false,
              });
              yield* writer.action("links", {
                op: "filesystem.remove",
                path: "/tmp/write-only",
                recursive: false,
              });
              const snapshot = yield* client.action("links", {
                op: "filesystem.export",
                maxBytes: 25165824,
              });
              expect(
                snapshot.source.filesystem.entries.filter((entry) => entry.type === "hardlink"),
              ).toHaveLength(2);
              const encoded = yield* Schema.encodeEffect(Schema.fromJsonString(FilesystemSnapshot))(
                snapshot,
              );
              expect(
                yield* client.action("links", {
                  op: "filesystem.export",
                  maxBytes: Buffer.byteLength(encoded),
                }),
              ).toEqual(snapshot);
              const invalid = {
                ...snapshot,
                source: {
                  ...snapshot.source,
                  filesystem: {
                    entries: [
                      ...snapshot.source.filesystem.entries,
                      { type: "hardlink" as const, path: "/tmp/invalid", target: "/tmp" },
                    ],
                  },
                },
              };
              const rejected = yield* client
                .action("links", { op: "filesystem.restore", snapshot: invalid })
                .pipe(Effect.result);
              expect(rejected._tag).toBe("Failure");
              expect(
                (yield* client.action("links", {
                  op: "filesystem.stat",
                  path: "/tmp/source",
                  follow: true,
                })).inode,
              ).toBe(source.inode);
              return { snapshot, token: grant.token, inode: source.inode };
            }),
          );
          yield* Effect.scoped(
            Effect.gen(function* () {
              const worker = yield* Effect.acquireRelease(
                Effect.sync(() => runtime(directory)),
                (worker) => Effect.promise(() => worker.dispose()),
              );
              const url = (yield* Effect.promise(() => worker.ready)).toString();
              const admin = yield* make({
                url,
                token: Redacted.make("cirro-local-test-credential"),
              });
              const client = yield* make({ url, token: Redacted.make(retained.token) });
              expect(
                (yield* client.action("links", {
                  op: "filesystem.stat",
                  path: "/tmp/alias",
                  follow: true,
                })).inode,
              ).toBe(retained.inode);
              yield* admin.create({
                id: "copy",
                policy: {
                  networkHosts: [],
                  interruptBudget: 1000,
                  memoryBytes: 8388608,
                  maxOutputBytes: 1048576,
                },
                snapshot: retained.snapshot,
              });
              const copiedGrant = yield* admin.mintCapability("copy", {
                permissions: ["read", "write"],
                expiresInSeconds: 600,
              });
              const copy = yield* make({ url, token: Redacted.make(copiedGrant.token) });
              const copied = yield* copy.action("copy", {
                op: "filesystem.stat",
                path: "/tmp/alias",
                follow: true,
              });
              expect(
                yield* copy.action("copy", {
                  op: "filesystem.stat",
                  path: "/tmp/source",
                  follow: true,
                }),
              ).toMatchObject({ inode: copied.inode, nlink: 2, uid: 123, gid: 456 });
              const originalData = yield* client.action("links", {
                op: "filesystem.readFile",
                path: "/tmp/source",
              });
              yield* copy.action("copy", {
                op: "filesystem.writeFile",
                path: "/tmp/alias",
                content: "copy",
                encoding: "utf8",
              });
              expect(
                (yield* copy.action("copy", { op: "filesystem.readFile", path: "/tmp/source" }))
                  .content,
              ).toBe(Buffer.from("copy").toString("base64"));
              expect(
                (yield* client.action("links", { op: "filesystem.readFile", path: "/tmp/source" }))
                  .content,
              ).toBe(originalData.content);
              const symbolic = yield* copy.action("copy", {
                op: "filesystem.stat",
                path: "/tmp/symbolic",
                follow: false,
              });
              expect(
                yield* copy.action("copy", {
                  op: "filesystem.stat",
                  path: "/tmp/symbolic-alias",
                  follow: false,
                }),
              ).toMatchObject({ inode: symbolic.inode, kind: "symlink", nlink: 2 });
              yield* client.action("links", {
                op: "filesystem.remove",
                path: "/tmp/source",
                recursive: false,
              });
              expect(
                (yield* client.action("links", {
                  op: "filesystem.stat",
                  path: "/tmp/alias",
                  follow: true,
                })).nlink,
              ).toBe(1);
            }),
          );
        }),
      ).pipe(Effect.provide(FetchHttpClient.layer)),
    ),
  15000,
);

test(
  "native WASI aliases share buffers and retain open files through unlink and rename",
  () =>
    Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const directory = yield* Effect.acquireRelease(
            Effect.promise(() => mkdtemp(join(tmpdir(), "boxes-wasi-hardlinks-"))),
            (path) => Effect.promise(() => rm(path, { recursive: true, force: true })),
          );
          const worker = yield* Effect.acquireRelease(
            Effect.sync(() => runtime(directory)),
            (worker) => Effect.promise(() => worker.dispose()),
          );
          const url = (yield* Effect.promise(() => worker.ready)).toString();
          const admin = yield* make({ url, token: Redacted.make("cirro-local-test-credential") });
          yield* admin.create({
            id: "wasi-links",
            policy: {
              networkHosts: [],
              interruptBudget: 10000,
              memoryBytes: 8388608,
              maxOutputBytes: 1048576,
            },
          });
          const grant = yield* admin.mintCapability("wasi-links", {
            permissions: ["read", "write", "execute"],
            expiresInSeconds: 600,
          });
          const client = yield* make({ url, token: Redacted.make(grant.token) });
          const source = Buffer.from(
            yield* Effect.promise(() => Bun.file("dist/wasi-hardlinks.wasm").arrayBuffer()),
          ).toString("base64");
          const result = yield* client.action("wasi-links", {
            op: "process.run",
            id: "linked",
            language: "wasm",
            source,
          });
          expect(result.output).toMatchObject({
            exitCode: 0,
            stdout: "shared inode descriptors survived\n",
          });
          yield* client.action("wasi-links", {
            op: "filesystem.mkdir",
            path: "/tmp/hidden",
            recursive: false,
          });
          yield* client.action("wasi-links", {
            op: "filesystem.writeFile",
            path: "/tmp/visible",
            content: "hidden",
            encoding: "utf8",
          });
          yield* client.action("wasi-links", {
            op: "filesystem.link",
            from: "/tmp/visible",
            to: "/tmp/hidden/alias",
            follow: false,
          });
          yield* client.action("wasi-links", {
            op: "filesystem.chmod",
            path: "/tmp/hidden",
            mode: 0,
          });
          expect(
            (yield* client.action("wasi-links", {
              op: "process.run",
              id: "hidden",
              language: "wasm",
              source,
              args: ["--hidden"],
            })).output,
          ).toMatchObject({ exitCode: 0, stdout: "hidden alias retained\n" });
          yield* client.action("wasi-links", {
            op: "filesystem.chmod",
            path: "/tmp/hidden",
            mode: 448,
          });
          expect(
            (yield* client.action("wasi-links", {
              op: "filesystem.readFile",
              path: "/tmp/hidden/alias",
            })).content,
          ).toBe(Buffer.from("hidden").toString("base64"));
          expect(
            yield* client.action("wasi-links", { op: "filesystem.exists", path: "/tmp/visible" }),
          ).toEqual({ exists: false });
          yield* client.action("wasi-links", {
            op: "filesystem.writeFile",
            path: "/tmp/source",
            content: "readonly",
            encoding: "utf8",
          });
          const readonly = yield* admin.mintCapability("wasi-links", {
            permissions: ["read", "execute"],
            expiresInSeconds: 600,
          });
          const reader = yield* make({ url, token: Redacted.make(readonly.token) });
          expect(
            (yield* reader.action("wasi-links", {
              op: "process.run",
              id: "denied",
              language: "wasm",
              source,
              args: ["--denied"],
            })).output,
          ).toMatchObject({ exitCode: 0, stdout: "link denied\n" });
          expect(
            yield* client.action("wasi-links", { op: "filesystem.exists", path: "/tmp/denied" }),
          ).toEqual({ exists: false });
        }),
      ).pipe(Effect.provide(FetchHttpClient.layer)),
    ),
  15000,
);
