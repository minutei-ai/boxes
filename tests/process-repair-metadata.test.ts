import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initSync, Kernel } from "../dist/kernel/cirro_kernel";
import { Clock, Effect, Redacted, Schema, Struct } from "effect";
import { FetchHttpClient } from "effect/http";
import { make } from "../src/sdk";
import { Head, ProcessDelivery, StoredRun, StoredRunMetadata } from "../src/contracts";
import { runtime } from "../tooling/worker-test";

test(
  "repair dispatches queued listing ETags without receipt downloads after Worker replacement",
  () =>
    Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const directory = yield* Effect.acquireRelease(
            Effect.promise(() => mkdtemp(join(tmpdir(), "boxes-repair-metadata-"))),
            (path) => Effect.promise(() => rm(path, { recursive: true, force: true })),
          );
          const id = "repair-metadata";
          const token = yield* Effect.scoped(
            Effect.gen(function* () {
              const first = yield* Effect.acquireRelease(
                Effect.sync(() => runtime(directory)),
                (worker) => Effect.promise(() => worker.dispose()),
              );
              const url = (yield* Effect.promise(() => first.ready)).toString();
              const admin = yield* make({
                url,
                token: Redacted.make("cirro-local-test-credential"),
              });
              yield* admin.create({
                id,
                policy: {
                  networkHosts: [],
                  interruptBudget: 1000,
                  memoryBytes: 8388608,
                  maxOutputBytes: 1048576,
                },
              });
              const grant = yield* admin.mintCapability(id, {
                permissions: ["read", "write", "execute", "manage"],
                expiresInSeconds: 600,
              });
              const client = yield* make({ url, token: Redacted.make(grant.token) });
              yield* client.action(id, {
                op: "filesystem.writeFile",
                path: "/confirmed",
                content: "",
                encoding: "utf8",
              });
              yield* client.action(id, {
                op: "process.spawn",
                execution: {
                  op: "process.run",
                  id: "seed",
                  language: "javascript",
                  source:
                    'export default async ({ tools }) => tools.call({ op: "filesystem.appendFile", path: "/confirmed", content: "A" })',
                },
              });
              yield* client.action(id, {
                op: "process.run",
                id: "terminal",
                language: "javascript",
                source: "export default () => 42",
              });
              const objects = yield* Effect.promise(() => first.objects);
              const object = yield* Effect.promise(() => objects.get(`processes/${id}/seed.json`));
              if (object === null) return yield* Effect.die("Queued receipt is missing");
              const stored = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(StoredRun))(
                yield* Effect.promise(() => object.text()),
              );
              const now = yield* Clock.currentTimeMillis;
              const records = [
                ...Array.from({ length: 101 }, (_, index) => ({
                  ...stored,
                  id: `queued-${String(index).padStart(3, "0")}`,
                })),
                { ...stored, id: "active", status: "running" as const, deadlineAt: now + 900000 },
              ];
              yield* Effect.forEach(
                records,
                (record) =>
                  Effect.promise(() =>
                    objects.put(
                      `processes/${id}/${record.id}.json`,
                      Schema.encodeSync(Schema.fromJsonString(StoredRun))(record),
                      {
                        customMetadata: Schema.encodeSync(StoredRunMetadata)({
                          format: "run-v7",
                          summary: {
                            ...Struct.omit(record, [
                              "output",
                              "authority",
                              "deadlineAt",
                              "checkpoint",
                              "checkpointCount",
                              "inputMode",
                            ]),
                            stdinMode: record.inputMode,
                          },
                        }),
                      },
                    ),
                  ),
                { concurrency: 8 },
              );
              return grant.token;
            }),
          );
          const second = yield* Effect.acquireRelease(
            Effect.sync(() => runtime(directory)),
            (worker) => Effect.promise(() => worker.dispose()),
          );
          const url = (yield* Effect.promise(() => second.ready)).toString();
          const client = yield* make({ url, token: Redacted.make(token) });
          const control = yield* Effect.promise(() => second.control);
          const repaired = yield* Effect.promise(() => control.repair());
          expect([repaired.notifications, repaired.receiptReads]).toEqual([102, 1]);
          const objects = yield* Effect.promise(() => second.objects);
          const queued = yield* Effect.promise(() => objects.head(`processes/${id}/seed.json`));
          if (queued === null) return yield* Effect.die("Queued receipt disappeared during repair");
          const delivery = Schema.encodeSync(ProcessDelivery)({
            key: queued.key,
            eTag: queued.etag,
          });
          const deliveryTimestamp = new Date(yield* Clock.currentTimeMillis);
          for (const attempt of [1, 2])
            yield* Effect.promise(() =>
              control.deliver("repair-metadata", [
                {
                  id: `delivery-${attempt}`,
                  timestamp: deliveryTimestamp,
                  attempts: attempt,
                  body: delivery,
                },
              ]),
            );
          expect((yield* client.action(id, { op: "process.get", id: "seed" })).status).toBe(
            "exited",
          );
          expect((yield* client.action(id, { op: "process.get", id: "queued-000" })).status).toBe(
            "queued",
          );
          expect((yield* client.action(id, { op: "process.get", id: "active" })).status).toBe(
            "running",
          );
          const confirmed = yield* client.action(id, {
            op: "filesystem.readFile",
            path: "/confirmed",
          });
          expect(Buffer.from(confirmed.content, confirmed.encoding).toString()).toBe("A");
          yield* client.action(id, { op: "vm.dispose" });
        }),
      ).pipe(Effect.provide(FetchHttpClient.layer)),
    ),
  20_000,
);

test(
  "expired Python repair releases only its retained inodes and duplicate delivery preserves the head",
  () =>
    Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const directory = yield* Effect.acquireRelease(
            Effect.promise(() => mkdtemp(join(tmpdir(), "boxes-python-orphan-repair-"))),
            (path) => Effect.promise(() => rm(path, { recursive: true, force: true })),
          );
          const id = "python-orphan-repair";
          const seeded = yield* Effect.scoped(
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
                id,
                policy: {
                  networkHosts: [],
                  interruptBudget: 100000,
                  memoryBytes: 16777216,
                  maxOutputBytes: 1048576,
                },
              });
              const grant = yield* admin.mintCapability(id, {
                permissions: ["read", "write", "execute", "manage"],
                expiresInSeconds: 3600,
              });
              const client = yield* make({ url, token: Redacted.make(grant.token) });
              for (const [path, content] of [
                ["/confirmed", ""],
                ["/tmp/open", "retained"],
              ] as const)
                yield* client.action(id, {
                  op: "filesystem.writeFile",
                  path,
                  content,
                  encoding: "utf8",
                });
              yield* client.action(id, { op: "contexts.create", id: "files", language: "python" });
              const seed = yield* client.action(id, {
                op: "python.execute",
                id: "seed",
                contextId: "files",
                source:
                  "import os\nawait tools.call({'op':'filesystem.appendFile','path':'/confirmed','content':'X'})\nfd=os.open('/tmp/open',os.O_RDWR)\nawait tools.call({'op':'filesystem.remove','path':'/tmp/open','recursive':False})\nos.fstat(fd).st_ino",
              });
              expect(seed.output?.stderr).toBe("");
              const inode = yield* Schema.decodeUnknownEffect(Schema.Int)(seed.output?.result);
              const objects = yield* Effect.promise(() => worker.objects);
              const headObject = yield* Effect.promise(() =>
                objects.get(`sandboxes/${id}/head.json`),
              );
              if (headObject === null) return yield* Effect.die("Missing seeded head");
              const head = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Head))(
                yield* Effect.promise(() => headObject.text()),
              );
              const bytes = yield* Effect.promise(() =>
                Bun.file("dist/kernel/cirro_kernel_bg.wasm").arrayBuffer(),
              );
              yield* Effect.sync(() => initSync({ module: new WebAssembly.Module(bytes) }));
              const kernel = yield* Effect.acquireRelease(
                Effect.sync(() => new Kernel(head.manifest)),
                (kernel) => Effect.sync(() => kernel.free()),
              );
              expect(
                kernel.retain_inode("execution:interrupted", 0n, BigInt(inode), "/tmp/open"),
              ).toBe(true);
              kernel.advance();
              const changed = yield* Effect.promise(() =>
                objects.put(
                  `sandboxes/${id}/head.json`,
                  Schema.encodeSync(Schema.fromJsonString(Head))({
                    ...head,
                    manifest: kernel.manifest(),
                  }),
                  { onlyIf: { etagMatches: headObject.etag } },
                ),
              );
              expect(changed).not.toBeNull();
              const source = yield* Effect.promise(() => objects.get(`processes/${id}/seed.json`));
              if (source === null) return yield* Effect.die("Missing seeded receipt");
              const stored = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(StoredRun))(
                yield* Effect.promise(() => source.text()),
              );
              const record = {
                ...stored,
                id: "interrupted",
                context: null,
                status: "running" as const,
                finishedAt: null,
                deadlineAt: 0,
              };
              const receipt = yield* Effect.promise(() =>
                objects.put(
                  `processes/${id}/interrupted.json`,
                  Schema.encodeSync(Schema.fromJsonString(StoredRun))(record),
                  {
                    customMetadata: Schema.encodeSync(StoredRunMetadata)({
                      format: "run-v7",
                      summary: {
                        ...Struct.omit(record, [
                          "output",
                          "authority",
                          "deadlineAt",
                          "checkpoint",
                          "checkpointCount",
                          "inputMode",
                        ]),
                        stdinMode: record.inputMode,
                      },
                    }),
                  },
                ),
              );
              if (receipt === null) return yield* Effect.die("Missing seeded publication");
              return { token: grant.token, event: { key: receipt.key, eTag: receipt.etag } };
            }),
          );
          const worker = yield* Effect.acquireRelease(
            Effect.sync(() => runtime(directory)),
            (worker) => Effect.promise(() => worker.dispose()),
          );
          const url = (yield* Effect.promise(() => worker.ready)).toString();
          const client = yield* make({ url, token: Redacted.make(seeded.token) });
          const control = yield* Effect.promise(() => worker.control);
          const body = Schema.encodeSync(ProcessDelivery)(seeded.event);
          const deliveryTimestamp = new Date(yield* Clock.currentTimeMillis);
          yield* Effect.promise(() =>
            control.deliver("python-orphan-repair", [
              { id: "expired", timestamp: deliveryTimestamp, attempts: 1, body },
            ]),
          );
          expect((yield* client.action(id, { op: "process.get", id: "interrupted" })).status).toBe(
            "failed",
          );
          expect((yield* client.action(id, { op: "vm.status" })).filesystemBytes).toBe(9);
          const continued = yield* client.action(id, {
            op: "python.execute",
            id: "continue",
            contextId: "files",
            source: "os.read(fd,20).decode()",
          });
          expect(continued.output?.stderr).toBe("");
          expect(continued.output?.result).toBe("retained");
          yield* client.action(id, { op: "contexts.delete", id: "files" });
          expect((yield* client.action(id, { op: "vm.status" })).filesystemBytes).toBe(1);
          expect(
            Buffer.from(
              (yield* client.action(id, { op: "filesystem.readFile", path: "/confirmed" })).content,
              "base64",
            ).toString(),
          ).toBe("X");
          const objects = yield* Effect.promise(() => worker.objects);
          const before = yield* Effect.promise(() => objects.head(`sandboxes/${id}/head.json`));
          yield* Effect.promise(() =>
            control.deliver("python-orphan-repair", [
              { id: "duplicate", timestamp: deliveryTimestamp, attempts: 2, body },
            ]),
          );
          const after = yield* Effect.promise(() => objects.head(`sandboxes/${id}/head.json`));
          expect(after?.version).toBe(before?.version);
        }),
      ).pipe(Effect.provide(FetchHttpClient.layer)),
    ),
  30000,
);
