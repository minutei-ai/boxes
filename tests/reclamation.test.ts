import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { Effect, Redacted, Schema } from "effect";
import { FetchHttpClient } from "effect/http";
import { make } from "../src/sdk";
import { Head, ProcessDelivery, ReclamationState, StoredRun } from "../src/contracts";
import { runtime } from "../tooling/worker-test";

test(
  "reclamation resumes bounded R2 deletion after replacement and preserves the disposal fence",
  () =>
    Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const directory = yield* Effect.acquireRelease(
            Effect.promise(() => mkdtemp("/tmp/boxes-reclamation-")),
            (path) => Effect.promise(() => rm(path, { recursive: true, force: true })),
          );
          const id = "collect";
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
              const policy = {
                networkHosts: [],
                interruptBudget: 1000,
                memoryBytes: 8388608,
                maxOutputBytes: 1048576,
              };
              for (const name of [id, `${id}-neighbor`])
                yield* admin.create({ id: name, policy, environment: { PRIVATE: "erase-me" } });
              const grant = yield* admin.mintCapability(id, {
                permissions: ["read", "write", "execute", "manage"],
                expiresInSeconds: 600,
              });
              const client = yield* make({ url, token: Redacted.make(grant.token) });
              const invalid = yield* Effect.promise(() =>
                fetch(new URL(`/v1/sandboxes/${id}/action`, url), {
                  method: "POST",
                  headers: {
                    authorization: `Bearer ${grant.token}`,
                    "content-type": "application/json",
                  },
                  body: '{"op":"vm.reclaim","limit":0}',
                }),
              );
              expect(invalid.status).toBe(400);
              expect(
                yield* client.action(id, { op: "vm.reclaim", limit: 1 }).pipe(Effect.flip),
              ).toMatchObject({ status: 409, error: "CONFLICT" });
              yield* client.action(id, {
                op: "filesystem.writeFile",
                path: "/large",
                content: "private file",
                encoding: "utf8",
              });
              yield* client.action(id, {
                op: "process.run",
                id: "finished",
                language: "javascript",
                source:
                  'export default ({console}) => { console.log("retained output"); return 42; }',
              });
              const objects = yield* Effect.promise(() => worker.objects);
              yield* Effect.forEach(
                Array.from({ length: 1005 }, (_, i) => i),
                (i) =>
                  Effect.promise(() =>
                    objects.put(
                      `sandboxes/${id}/blobs/seed-${String(i).padStart(5, "0")}`,
                      "garbage",
                    ),
                  ),
                { concurrency: 8 },
              );
              for (const key of [
                `process-input/${id}/unused.json`,
                `schedules/${id}/unused.json`,
                `sandboxes/${id}/zzz-late`,
              ])
                yield* Effect.promise(() => objects.put(key, "unused"));
              const readonly = yield* admin.mintCapability(id, {
                permissions: ["read"],
                expiresInSeconds: 600,
              });
              yield* client.action(id, { op: "vm.dispose" });
              const reader = yield* make({ url, token: Redacted.make(readonly.token) });
              expect(
                yield* reader.action(id, { op: "vm.reclaim", limit: 1 }).pipe(Effect.flip),
              ).toMatchObject({ status: 403, error: "FORBIDDEN" });
              expect(
                yield* Effect.promise(() => objects.head(`reclamations/${id}.json`)),
              ).toBeNull();
              for (const phase of [
                "processes",
                "inputs",
                "inputs",
                "schedules",
                "schedules",
                "objects",
              ] as const) {
                const progress = yield* client.action(id, { op: "vm.reclaim", limit: 1000 });
                expect(progress.phase).toBe(phase);
              }
              const first = yield* client.action(id, { op: "vm.reclaim", limit: 1000 });
              expect(first).toMatchObject({ phase: "objects", status: "pending", removed: 1000 });
              return { token: grant.token, policy };
            }),
          );
          const replacement = yield* Effect.acquireRelease(
            Effect.sync(() => runtime(directory)),
            (worker) => Effect.promise(() => worker.dispose()),
          );
          const url = (yield* Effect.promise(() => replacement.ready)).toString();
          const client = yield* make({ url, token: Redacted.make(retained.token) });
          const steps = [];
          for (const _ of Array.from({ length: 20 })) {
            const step = yield* client.action(id, { op: "vm.reclaim", limit: 1 });
            expect(step.removed).toBeLessThanOrEqual(1);
            steps.push(step);
            if (step.status === "complete") break;
          }
          expect(steps.at(-1)?.status).toBe("complete");
          const objects = yield* Effect.promise(() => replacement.objects);
          for (const prefix of [`processes/${id}/`, `process-input/${id}/`, `schedules/${id}/`])
            expect((yield* Effect.promise(() => objects.list({ prefix }))).objects).toEqual([]);
          expect(
            (yield* Effect.promise(() => objects.list({ prefix: `sandboxes/${id}/` }))).objects.map(
              (o) => o.key,
            ),
          ).toEqual([`sandboxes/${id}/head.json`]);
          const object = yield* Effect.promise(() => objects.get(`sandboxes/${id}/head.json`));
          if (object === null) return yield* Effect.die("Reclamation removed the disposal fence");
          const head = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Head))(
            yield* Effect.promise(() => object.text()),
          );
          expect(head.deleted).toBe(true);
          expect(head.environment).toEqual({});
          expect(head.manifest).not.toContain("large");
          expect(
            yield* Effect.promise(() => objects.head(`sandboxes/${id}-neighbor/head.json`)),
          ).not.toBeNull();
          const admin = yield* make({ url, token: Redacted.make("cirro-local-test-credential") });
          expect(
            yield* admin.create({ id, policy: retained.policy }).pipe(Effect.flip),
          ).toMatchObject({ status: 409, error: "EEXIST" });
          expect(
            yield* admin
              .mintCapability(id, {
                permissions: ["read", "manage"],
                expiresInSeconds: 60,
              })
              .pipe(Effect.flip),
          ).toMatchObject({ status: 403, error: "FORBIDDEN" });
          const cleanup = yield* admin.mintCapability(id, {
            permissions: ["manage"],
            expiresInSeconds: 60,
          });
          const manager = yield* make({ url, token: Redacted.make(cleanup.token) });
          expect(yield* manager.action(id, { op: "vm.status" }).pipe(Effect.flip)).toMatchObject({
            status: 403,
            error: "FORBIDDEN",
          });
          yield* Effect.promise(() => objects.put(`sandboxes/${id}/late`, "late orphan"));
          for (const _ of Array.from({ length: 8 })) {
            const step = yield* manager.action(id, { op: "vm.reclaim", limit: 1000 });
            if (step.status === "complete") break;
          }
          expect(yield* Effect.promise(() => objects.head(`sandboxes/${id}/late`))).toBeNull();
          const concurrent = yield* Effect.forEach(
            [0, 1, 2],
            () => manager.action(id, { op: "vm.reclaim", limit: 1000 }).pipe(Effect.result),
            { concurrency: 3 },
          );
          expect(concurrent.some((result) => result._tag === "Success")).toBe(true);
          for (const result of concurrent) {
            if (result._tag === "Failure")
              expect(result.failure).toMatchObject({ _tag: "BoxesError", status: 409 });
          }
          for (const _ of Array.from({ length: 8 })) {
            const step = yield* manager.action(id, { op: "vm.reclaim", limit: 1000 });
            if (step.status === "complete") break;
          }
          const state = yield* Effect.promise(() => objects.get(`reclamations/${id}.json`));
          if (state === null) return yield* Effect.die("Missing persisted reclamation progress");
          expect(
            yield* Schema.decodeUnknownEffect(Schema.fromJsonString(ReclamationState))(
              yield* Effect.promise(() => state.text()),
            ),
          ).toMatchObject({ phase: "complete" });
        }),
      ).pipe(Effect.provide(FetchHttpClient.layer)),
    ),
  30000,
);

test("reclamation waits for native queued disposal settlement before removing receipts or output", () =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const directory = yield* Effect.acquireRelease(
          Effect.promise(() => mkdtemp("/tmp/boxes-reclamation-pending-")),
          (path) => Effect.promise(() => rm(path, { recursive: true, force: true })),
        );
        const worker = yield* Effect.acquireRelease(
          Effect.sync(() => runtime(directory)),
          (worker) => Effect.promise(() => worker.dispose()),
        );
        const url = (yield* Effect.promise(() => worker.ready)).toString();
        const admin = yield* make({ url, token: Redacted.make("cirro-local-test-credential") });
        const id = "queued";
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
          permissions: ["read", "execute", "manage"],
          expiresInSeconds: 600,
        });
        const client = yield* make({ url, token: Redacted.make(grant.token) });
        yield* client.action(id, {
          op: "process.spawn",
          execution: {
            op: "process.run",
            id: "pending",
            language: "javascript",
            source: "export default () => 42;",
          },
        });
        const objects = yield* Effect.promise(() => worker.objects);
        const key = `processes/${id}/pending.json`;
        const before = yield* Effect.promise(() => objects.head(key));
        if (before === null) return yield* Effect.die("Missing queued receipt");
        const queued = yield* Effect.promise(() => objects.get(key));
        if (queued === null) return yield* Effect.die("Missing queued body");
        const queuedBody = yield* Effect.promise(() => queued.text());
        yield* client.action(id, { op: "vm.dispose" });
        expect(yield* client.action(id, { op: "vm.reclaim", limit: 1000 })).toEqual({
          phase: "processes",
          status: "blocked",
          removed: 0,
          blocking: ["pending"],
        });
        expect((yield* Effect.promise(() => objects.head(key)))?.etag).toBe(before.etag);
        const control = yield* Effect.promise(() => worker.control);
        const delivery = yield* Effect.promise(() =>
          control.deliver("executions", [
            {
              id: "settle",
              timestamp: new Date(),
              attempts: 1,
              body: Schema.encodeSync(ProcessDelivery)({ key, eTag: before.etag }),
            },
          ]),
        );
        expect(delivery.explicitAcks).toEqual(["settle"]);
        const settled = yield* Effect.promise(() => objects.get(key));
        if (settled === null) return yield* Effect.die("Settlement receipt disappeared");
        expect(
          (yield* Schema.decodeUnknownEffect(Schema.fromJsonString(StoredRun))(
            yield* Effect.promise(() => settled.text()),
          )).status,
        ).toBe("cancelled");
        expect((yield* client.action(id, { op: "vm.reclaim", limit: 1 })).removed).toBe(1);
        expect(yield* Effect.promise(() => objects.head(key))).toBeNull();
        for (const phase of ["inputs", "schedules", "objects"] as const)
          expect((yield* client.action(id, { op: "vm.reclaim", limit: 1 })).phase).toBe(phase);
        const marker = `sandboxes/${id}/blobs/keep-until-settled`;
        yield* Effect.promise(() => objects.put(marker, "keep"));
        const reappeared = yield* Effect.promise(() =>
          objects.put(key, queuedBody, {
            customMetadata: before.customMetadata,
          }),
        );
        if (reappeared === null) return yield* Effect.die("Late queued receipt was not persisted");
        expect((yield* client.action(id, { op: "vm.reclaim", limit: 1000 })).status).toBe(
          "blocked",
        );
        expect(yield* Effect.promise(() => objects.head(marker))).not.toBeNull();
        const repeated = yield* Effect.promise(() =>
          control.deliver("executions", [
            {
              id: "late-settle",
              timestamp: new Date(),
              attempts: 2,
              body: Schema.encodeSync(ProcessDelivery)({ key, eTag: reappeared.etag }),
            },
          ]),
        );
        expect(repeated.explicitAcks).toEqual(["late-settle"]);
        expect((yield* client.action(id, { op: "vm.reclaim", limit: 1000 })).phase).toBe(
          "processes",
        );
        expect(
          (yield* client.action(id, { op: "vm.reclaim", limit: 1000 })).removed,
        ).toBeGreaterThan(0);
        expect(yield* Effect.promise(() => objects.head(marker))).toBeNull();
        const replay = yield* Effect.promise(() =>
          control.deliver("executions", [
            {
              id: "purged-replay",
              timestamp: new Date(),
              attempts: 3,
              body: Schema.encodeSync(ProcessDelivery)({ key, eTag: reappeared.etag }),
            },
          ]),
        );
        expect(replay.explicitAcks).toEqual(["purged-replay"]);
        expect(yield* Effect.promise(() => objects.head(key))).toBeNull();
      }),
    ).pipe(Effect.provide(FetchHttpClient.layer)),
  ));
