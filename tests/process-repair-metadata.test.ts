import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { Clock, Effect, Redacted, Schema, Struct } from "effect";
import { FetchHttpClient } from "effect/http";
import { make } from "../src/sdk";
import { ProcessDelivery, StoredRun, StoredRunMetadata } from "../src/contracts";
import { runtime } from "../tooling/worker-test";

test(
  "repair dispatches queued listing ETags without receipt downloads after Worker replacement",
  () =>
    Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const directory = yield* Effect.acquireRelease(
            Effect.promise(() => mkdtemp("/tmp/boxes-repair-metadata-")),
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
          for (const attempt of [1, 2])
            yield* Effect.promise(() =>
              control.deliver("repair-metadata", [
                {
                  id: `delivery-${attempt}`,
                  timestamp: new Date(),
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
