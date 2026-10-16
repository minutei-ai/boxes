import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Redacted, Schema } from "effect";
import { FetchHttpClient } from "effect/http";
import { initSync, Kernel } from "../dist/kernel/cirro_kernel";
import { ReadPlan, Policy } from "../src/contracts";
import { defaultSoftware } from "../src/default-software";
import { make, makeBinding } from "../src/sdk";
import { prepareSoftwareBase } from "../tooling/software-base";
import { downloadSoftware } from "../tooling/software-artifacts";
import { runtime } from "../tooling/worker-test";

test(
  "native R2 defaults share immutable software across isolated roots, survive collection and replacement, and reject corruption",
  () =>
    Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const directory = yield* Effect.acquireRelease(
            Effect.promise(() => mkdtemp(join(tmpdir(), "boxes-default-software-"))),
            (path) => Effect.promise(() => rm(path, { recursive: true, force: true })),
          );
          const kernelBytes = yield* Effect.promise(() =>
            Bun.file(new URL("../dist/kernel/cirro_kernel_bg.wasm", import.meta.url)).arrayBuffer(),
          );
          const base = yield* prepareSoftwareBase({
            kernelDigest: new Bun.CryptoHasher("sha256").update(kernelBytes).digest("hex"),
            artifacts: defaultSoftware.slice(0, 2),
          });
          const retained = yield* Effect.scoped(
            Effect.gen(function* () {
              const worker = yield* Effect.acquireRelease(
                Effect.sync(() =>
                  runtime(directory, { softwareBase: base.digest, controlled: false }),
                ),
                (worker) => Effect.promise(() => worker.dispose()),
              );
              const url = (yield* Effect.promise(() => worker.ready)).toString();
              const objects = yield* Effect.promise(() => worker.objects);
              const policy = Policy.make({
                networkHosts: [],
                interruptBudget: 100000,
                memoryBytes: 8388608,
                maxOutputBytes: 1048576,
              });
              yield* Effect.forEach(
                base.blocks,
                ([hash, bytes]) =>
                  Effect.promise(() => objects.put(`software/blobs/${hash}`, bytes)),
                { concurrency: 4, discard: true },
              );
              yield* Effect.promise(() =>
                objects.put(`software/bases/${base.digest}.json`, base.manifest),
              );
              const admin = yield* make({
                url,
                token: Redacted.make("cirro-local-test-credential"),
              });
              yield* Effect.forEach(
                ["first", "second"],
                (id) =>
                  admin.create({
                    id,
                    policy,
                  }),
                { concurrency: 2 },
              );
              const permissions = ["read", "write", "execute", "manage"] as const;
              const firstGrant = yield* admin.mintCapability("first", {
                permissions,
                expiresInSeconds: 3600,
              });
              const secondGrant = yield* admin.mintCapability("second", {
                permissions: ["read", "execute"],
                expiresInSeconds: 3600,
              });
              const binding = yield* Effect.promise(() => worker.service);
              const first = yield* makeBinding(binding, Redacted.make(firstGrant.token));
              const second = yield* makeBinding(binding, Redacted.make(secondGrant.token));
              yield* admin.create({
                id: "manual",
                policy,
                snapshot: {
                  kind: "snapshot-export",
                  source: {
                    format: "boxes-filesystem-snapshot-v1",
                    filesystem: {
                      entries: [
                        { path: "/", type: "directory", mode: "0755", uid: 0, gid: 0 },
                        { path: "/tmp", type: "directory", mode: "0777", uid: 0, gid: 0 },
                      ],
                    },
                  },
                },
              });
              const manualGrant = yield* admin.mintCapability("manual", {
                permissions,
                expiresInSeconds: 3600,
              });
              const manual = yield* makeBinding(binding, Redacted.make(manualGrant.token));
              expect(yield* manual.action("manual", { op: "software.list" })).toEqual([]);
              for (const artifact of defaultSoftware.slice(0, 2)) {
                const bytes = yield* downloadSoftware(artifact);
                const path = `/tmp/${artifact.name}.aospkg`;
                yield* manual.action("manual", {
                  op: "filesystem.writeFile",
                  path,
                  content: bytes.toString("base64"),
                  encoding: "base64",
                });
                yield* manual.action("manual", {
                  op: "software.install",
                  source: { path, digest: `sha256:${artifact.digest}` },
                });
                yield* manual.action("manual", { op: "filesystem.remove", path, recursive: false });
              }
              const privateObjects = yield* Effect.promise(() =>
                objects.list({ prefix: "sandboxes/manual/blobs/" }),
              );
              expect(privateObjects.truncated).toBe(false);
              const privateSoftware = privateObjects.objects.filter((object) =>
                base.blocks.has(object.key.slice(object.key.lastIndexOf("/") + 1)),
              );
              const payloadBytes = [...base.blocks.values()].reduce(
                (total, bytes) => total + bytes.byteLength,
                0,
              );
              expect(privateSoftware).toHaveLength(base.blocks.size);
              expect(privateSoftware.reduce((total, object) => total + object.size, 0)).toBe(
                payloadBytes,
              );
              yield* Effect.logInfo({
                phase: "software.storage",
                sharedPayloadBlobs: base.blocks.size,
                sharedPayloadBytes: payloadBytes,
                defaultRoots: 2,
                privateSoftwareBlobsPerDefaultRoot: 0,
                privateSoftwareBytesPerManualRoot: payloadBytes,
                privateSoftwareBlobsPerManualRoot: privateSoftware.length,
                manualInstallerAndSoftwareBlobs: privateObjects.objects.length,
                manualInstallerAndSoftwareBytes: privateObjects.objects.reduce(
                  (total, object) => total + object.size,
                  0,
                ),
              });
              const installed = yield* second.action("second", { op: "software.list" });
              expect(installed.map((item) => item.manifest.name)).toEqual(["sh", "jq"]);
              expect(
                (yield* Effect.promise(() => objects.list({ prefix: "sandboxes/first/blobs/" })))
                  .objects,
              ).toEqual([]);
              expect(
                (yield* Effect.promise(() => objects.list({ prefix: "sandboxes/second/blobs/" })))
                  .objects,
              ).toEqual([]);
              const shell = yield* second.action("second", {
                op: "process.execFile",
                id: "default-sh",
                command: "sh",
                args: ["-c", "printf available"],
              });
              expect(shell.output?.stdout).toBe("available");
              expect(shell.output?.exitCode).toBe(0);
              const jq = yield* second.action("second", {
                op: "process.execFile",
                id: "default-jq",
                command: "jq",
                args: ["-n", "{value:42}"],
              });
              expect(jq.output?.exitCode).toBe(0);
              expect(
                Schema.decodeUnknownSync(
                  Schema.fromJsonString(Schema.Struct({ value: Schema.Literal(42) })),
                )(jq.output?.stdout),
              ).toEqual({ value: 42 });
              const readonly = yield* first
                .action("first", {
                  op: "filesystem.writeFile",
                  path: "/opt/cirro/bin/sh",
                  content: "changed",
                  encoding: "utf8",
                })
                .pipe(Effect.result);
              expect(readonly._tag).toBe("Failure");
              if (readonly._tag === "Failure")
                expect(readonly.failure).toMatchObject({ _tag: "BoxesError", status: 403 });
              const copied = yield* first.action("first", {
                op: "process.run",
                id: "copy",
                language: "shell",
                source: "cp /opt/cirro/bin/sh /tmp/copied-sh",
              });
              expect(copied.output?.exitCode).toBe(0);
              expect(
                (yield* Effect.promise(() => objects.list({ prefix: "sandboxes/first/blobs/" })))
                  .objects,
              ).toEqual([]);
              yield* first.action("first", {
                op: "software.uninstall",
                packageId: defaultSoftware[0].digest,
              });
              const original = yield* first.action("first", {
                op: "filesystem.readFile",
                path: "/tmp/copied-sh",
                length: 8,
              });
              expect(Buffer.from(original.content, original.encoding).subarray(0, 4)).toEqual(
                Buffer.from([0, 97, 115, 109]),
              );
              yield* first.action("first", {
                op: "filesystem.writeFile",
                path: "/tmp/copied-sh",
                offset: 0,
                content: "X",
                encoding: "utf8",
              });
              expect(
                (yield* Effect.promise(() => objects.list({ prefix: "sandboxes/first/blobs/" })))
                  .objects,
              ).toHaveLength(1);
              const changed = yield* first.action("first", {
                op: "filesystem.readFile",
                path: "/tmp/copied-sh",
                length: 8,
              });
              expect(Buffer.from(changed.content, changed.encoding)).toEqual(
                Buffer.concat([
                  Buffer.from("X"),
                  Buffer.from(original.content, original.encoding).subarray(1),
                ]),
              );
              const foreign = yield* second
                .action("second", { op: "filesystem.readFile", path: "/tmp/copied-sh", length: 8 })
                .pipe(Effect.result);
              expect(foreign._tag).toBe("Failure");
              if (foreign._tag === "Failure")
                expect(foreign.failure).toMatchObject({ _tag: "BoxesError", status: 404 });
              yield* Effect.sync(() => initSync({ module: new WebAssembly.Module(kernelBytes) }));
              const kernel = yield* Effect.acquireRelease(
                Effect.sync(() => new Kernel(base.manifest)),
                (kernel) => Effect.sync(() => kernel.free()),
              );
              const plan = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(ReadPlan))(
                kernel.read_plan("/opt/cirro/bin/sh", 0n, 1n, false),
              );
              const block = plan.blocks[0];
              if (block === undefined) return yield* Effect.die("Missing real shell block");
              const content = base.blocks.get(block.hash);
              if (content === undefined) return yield* Effect.die("Missing prepared shell block");
              yield* Effect.promise(() =>
                objects.put(`sandboxes/second/blobs/${block.hash}`, content),
              );
              yield* Effect.promise(() => objects.delete(`software/blobs/${block.hash}`));
              const missing = yield* second
                .action("second", {
                  op: "filesystem.readFile",
                  path: "/opt/cirro/bin/sh",
                  length: 1,
                })
                .pipe(Effect.result);
              expect(missing._tag).toBe("Failure");
              if (missing._tag === "Failure")
                expect(missing.failure).toMatchObject({ _tag: "BoxesError", status: 500 });
              yield* Effect.promise(() =>
                objects.put(`software/blobs/${block.hash}`, Buffer.alloc(content.length)),
              );
              const corrupt = yield* second
                .action("second", {
                  op: "filesystem.readFile",
                  path: "/opt/cirro/bin/sh",
                  length: 1,
                })
                .pipe(Effect.result);
              expect(corrupt._tag).toBe("Failure");
              if (corrupt._tag === "Failure")
                expect(corrupt.failure).toMatchObject({ _tag: "BoxesError", status: 500 });
              yield* Effect.promise(() => objects.put(`software/blobs/${block.hash}`, content));
              yield* Effect.promise(() => objects.delete(`software/bases/${base.digest}.json`));
              const failed = yield* admin
                .create({
                  id: "missing-base",
                  policy: {
                    networkHosts: [],
                    interruptBudget: 1000,
                    memoryBytes: 8388608,
                    maxOutputBytes: 1048576,
                  },
                })
                .pipe(Effect.result);
              expect(failed._tag).toBe("Failure");
              if (failed._tag === "Failure")
                expect(failed.failure).toMatchObject({ _tag: "BoxesError", status: 500 });
              expect(
                yield* Effect.promise(() => objects.head("sandboxes/missing-base/head.json")),
              ).toBeNull();
              yield* Effect.promise(() =>
                objects.put(`software/bases/${base.digest}.json`, base.manifest),
              );
              yield* first.action("first", { op: "vm.dispose" });
              const collected = yield* first
                .action("first", { op: "vm.reclaim", limit: 1000 })
                .pipe(Effect.repeat({ until: (state) => state.status !== "pending", times: 7 }));
              expect(collected.status).toBe("complete");
              expect(
                (yield* Effect.promise(() => objects.list({ prefix: "software/blobs/" }))).objects,
              ).toHaveLength(base.blocks.size);
              return secondGrant.token;
            }),
          );
          const replacement = yield* Effect.acquireRelease(
            Effect.sync(() => runtime(directory, { controlled: false })),
            (worker) => Effect.promise(() => worker.dispose()),
          );
          yield* Effect.promise(() => replacement.ready);
          const second = yield* makeBinding(
            yield* Effect.promise(() => replacement.service),
            Redacted.make(retained),
          );
          const resumed = yield* second.action("second", {
            op: "process.execFile",
            id: "after-replacement",
            command: "sh",
            args: ["-c", "printf retained"],
          });
          expect(resumed.output?.stdout).toBe("retained");
          expect(resumed.output?.exitCode).toBe(0);
        }),
      ).pipe(Effect.provide(FetchHttpClient.layer)),
    ),
  20000,
);
