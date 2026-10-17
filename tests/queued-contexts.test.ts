import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Redacted, Schema } from "effect";
import { FetchHttpClient } from "effect/http";
import { make } from "../src/sdk";
import { ProcessDelivery, StoredCron } from "../src/contracts";
import { runtime } from "../tooling/worker-test";

const run = <A, E>(effect: Effect.Effect<A, E, import("effect/http/HttpClient").HttpClient>) =>
  Effect.runPromise(
    effect.pipe(
      Effect.provide(FetchHttpClient.layer),
      Effect.provideService(FetchHttpClient.RequestInit, { keepalive: false }),
    ),
  );
const policy = {
  networkHosts: [],
  interruptBudget: 1000,
  memoryBytes: 8388608,
  maxOutputBytes: 1048576,
};
const connect = Effect.fn("queuedContextTest.connect")(function* (
  directory: string,
  token: string,
) {
  const worker = yield* Effect.acquireRelease(
    Effect.sync(() => runtime(directory, { controlled: false })),
    (worker) => Effect.promise(() => worker.dispose()),
  );
  const url = (yield* Effect.promise(() => worker.ready)).toString();
  return { worker, boxes: yield* make({ url, token: Redacted.make(token) }) };
});
const delivery = Effect.fn("queuedContextTest.delivery")(function* (
  worker: ReturnType<typeof runtime>,
  sandboxId: string,
  id: string,
) {
  const key = `processes/${sandboxId}/${id}.json`;
  const objects = yield* Effect.promise(() => worker.objects);
  const object = yield* Effect.promise(() => objects.head(key));
  if (object === null) return yield* Effect.die("Missing queued receipt");
  return {
    id,
    timestamp: new Date(),
    attempts: 1,
    body: Schema.encodeSync(ProcessDelivery)({ key, eTag: object.etag }),
  };
});

test(
  "queued JS and Python heaps survive Worker replacement and duplicate delivery without replay",
  () =>
    run(
      Effect.scoped(
        Effect.gen(function* () {
          const directory = yield* Effect.acquireRelease(
            Effect.promise(() => mkdtemp(join(tmpdir(), "boxes-queued-contexts-"))),
            (path) => Effect.promise(() => rm(path, { recursive: true, force: true })),
          );
          const token = yield* Effect.scoped(
            Effect.gen(function* () {
              const first = yield* connect(directory, "cirro-local-test-credential");
              yield* first.boxes.create({ id: "queued-contexts", policy });
              const grant = yield* first.boxes.mintCapability("queued-contexts", {
                permissions: ["read", "write", "execute", "manage"],
                expiresInSeconds: 3600,
              });
              const boxes = yield* make({
                url: (yield* Effect.promise(() => first.worker.ready)).toString(),
                token: Redacted.make(grant.token),
              });
              for (const language of ["javascript", "python"] as const) {
                yield* boxes.action("queued-contexts", {
                  op: "contexts.create",
                  id: language,
                  language,
                });
                if (language === "javascript")
                  yield* boxes.action("queued-contexts", {
                    op: "javascript.execute",
                    id: "seed-js",
                    contextId: language,
                    source: "let value=40;globalThis.bump=()=>++value;",
                  });
                else
                  yield* boxes.action("queued-contexts", {
                    op: "python.execute",
                    id: "seed-py",
                    contextId: language,
                    source: "value=40\ndef bump():\n global value\n value+=1\n return value",
                  });
                const queued = yield* boxes.action("queued-contexts", {
                  op: "process.spawn",
                  execution: {
                    op: "process.run",
                    language,
                    id: `queued-${language}`,
                    contextId: language,
                    source: "bump()",
                  },
                });
                expect(queued.status).toBe("queued");
                expect(queued.context).toEqual({ id: language, generation: 0 });
              }
              return grant.token;
            }),
          );
          const second = yield* connect(directory, token);
          const control = yield* Effect.promise(() => second.worker.control);
          for (const language of ["javascript", "python"] as const) {
            const message = yield* delivery(second.worker, "queued-contexts", `queued-${language}`);
            yield* Effect.promise(() => control.deliver("executions", [message]));
            const settled = yield* second.boxes.action("queued-contexts", {
              op: "process.get",
              id: `queued-${language}`,
            });
            expect(settled.status).toBe("exited");
            yield* Effect.promise(() => control.deliver("executions", [message]));
            const action = yield* Effect.sync(() => {
              if (language === "python")
                return { op: "python.evaluate" as const, expression: "bump()" };
              return { op: "typescript.evaluate" as const, expression: "globalThis.bump()" };
            });
            const next = yield* second.boxes.action("queued-contexts", {
              ...action,
              id: `next-${language}`,
              contextId: language,
            });
            expect(next.output?.result).toBe(42);
          }
          yield* second.boxes.action("queued-contexts", {
            op: "process.spawn",
            execution: {
              op: "javascript.execute",
              id: "stale",
              contextId: "javascript",
              source: "globalThis.stale=true;",
            },
          });
          const stale = yield* delivery(second.worker, "queued-contexts", "stale");
          yield* second.boxes.action("queued-contexts", { op: "contexts.reset", id: "javascript" });
          yield* Effect.promise(() => control.deliver("executions", [stale]));
          expect(
            (yield* second.boxes.action("queued-contexts", { op: "process.get", id: "stale" }))
              .status,
          ).toBe("failed");
          expect(
            (yield* second.boxes.action("queued-contexts", {
              op: "contexts.get",
              id: "javascript",
            })).state,
          ).toBe("idle");
          const clean = yield* second.boxes.action("queued-contexts", {
            op: "javascript.evaluate",
            id: "clean",
            contextId: "javascript",
            expression: "typeof globalThis.stale",
          });
          expect(clean.output?.result).toBe("undefined");
        }),
      ),
    ),
  30000,
);

test(
  "busy contexts retry queued work without claiming a process",
  () =>
    run(
      Effect.scoped(
        Effect.gen(function* () {
          const directory = yield* Effect.acquireRelease(
            Effect.promise(() => mkdtemp(join(tmpdir(), "boxes-busy-context-"))),
            (path) => Effect.promise(() => rm(path, { recursive: true, force: true })),
          );
          const first = yield* connect(directory, "cirro-local-test-credential");
          yield* first.boxes.create({ id: "busy", policy });
          const grant = yield* first.boxes.mintCapability("busy", {
            permissions: ["read", "write", "execute", "manage"],
            expiresInSeconds: 3600,
          });
          const boxes = yield* make({
            url: (yield* Effect.promise(() => first.worker.ready)).toString(),
            token: Redacted.make(grant.token),
          });
          yield* boxes.action("busy", { op: "contexts.create", id: "state" });
          yield* boxes.action("busy", {
            op: "process.spawn",
            execution: {
              op: "javascript.evaluate",
              id: "pending",
              contextId: "state",
              expression: "(globalThis.count=(globalThis.count||0)+1)",
            },
          });
          const message = yield* delivery(first.worker, "busy", "pending");
          const control = yield* Effect.promise(() => first.worker.control);
          const blocked = yield* Effect.promise(() =>
            control.contextBusyDelivery("busy", grant.token, "state", [message]),
          );
          expect(blocked.retryBatch.retry).toBe(false);
          expect(blocked.retryMessages).toEqual([{ msgId: "pending", delaySeconds: 1 }]);
          expect((yield* boxes.action("busy", { op: "process.get", id: "pending" })).status).toBe(
            "queued",
          );
          const objects = yield* Effect.promise(() => first.worker.objects);
          expect(
            (yield* Effect.promise(() => objects.head("processes/busy/pending.json")))?.etag,
          ).toBe(message.body.eTag);
          expect((yield* boxes.action("busy", { op: "contexts.get", id: "state" })).state).toBe(
            "idle",
          );
          yield* Effect.promise(() => control.deliver("executions", [message]));
          const settled = yield* boxes.action("busy", { op: "process.get", id: "pending" });
          expect(settled.status).toBe("exited");
          expect(settled.output?.result).toBe(1);
        }),
      ),
    ),
  10000,
);

test(
  "cron freezes context generation through replacement and rejects future occurrences after reset",
  () =>
    run(
      Effect.scoped(
        Effect.gen(function* () {
          const directory = yield* Effect.acquireRelease(
            Effect.promise(() => mkdtemp(join(tmpdir(), "boxes-cron-context-"))),
            (path) => Effect.promise(() => rm(path, { recursive: true, force: true })),
          );
          const saved = yield* Effect.scoped(
            Effect.gen(function* () {
              const first = yield* connect(directory, "cirro-local-test-credential");
              yield* first.boxes.create({ id: "cron-context", policy });
              const grant = yield* first.boxes.mintCapability("cron-context", {
                permissions: ["read", "write", "execute", "manage"],
                expiresInSeconds: 3600,
              });
              const boxes = yield* make({
                url: (yield* Effect.promise(() => first.worker.ready)).toString(),
                token: Redacted.make(grant.token),
              });
              yield* boxes.action("cron-context", { op: "contexts.create", id: "state" });
              yield* boxes.action("cron-context", {
                op: "javascript.execute",
                id: "seed",
                contextId: "state",
                source: "let value=40;globalThis.bump=()=>++value;",
              });
              const scheduled = yield* boxes.action("cron-context", {
                op: "cron.schedule",
                id: "recurring",
                schedule: "* * * * *",
                overlap: "queue",
                execution: {
                  op: "typescript.evaluate",
                  id: "tick",
                  contextId: "state",
                  expression: "globalThis.bump()",
                },
              });
              expect(scheduled.context).toEqual({ id: "state", generation: 0 });
              if (scheduled.nextRun === null)
                return yield* Effect.die("Schedule has no occurrence");
              return { token: grant.token, due: scheduled.nextRun };
            }),
          );
          const second = yield* connect(directory, saved.token);
          const control = yield* Effect.promise(() => second.worker.control);
          yield* Effect.promise(() => control.schedules(saved.due));
          const job = yield* second.boxes.action("cron-context", {
            op: "cron.get",
            id: "recurring",
          });
          if (job.lastProcessId === null || job.nextRun === null)
            return yield* Effect.die("Schedule did not launch");
          const nextRun = job.nextRun;
          const message = yield* delivery(second.worker, "cron-context", job.lastProcessId);
          yield* Effect.promise(() => control.deliver("executions", [message]));
          expect(
            (yield* second.boxes.action("cron-context", {
              op: "process.get",
              id: job.lastProcessId,
            })).output?.result,
          ).toBe(41);
          yield* second.boxes.action("cron-context", { op: "contexts.reset", id: "state" });
          yield* Effect.promise(() => control.schedules(nextRun));
          const stopped = yield* second.boxes.action("cron-context", {
            op: "cron.get",
            id: "recurring",
          });
          expect(stopped.state).toBe("failed");
          expect(stopped.runCount).toBe(1);
          expect(stopped.lastProcessId).toBe(job.lastProcessId);
          expect(stopped.error).toBe("Execution belongs to another context generation");
          expect(
            (yield* second.boxes.action("cron-context", { op: "contexts.get", id: "state" })).state,
          ).toBe("idle");
        }),
      ),
    ),
  15000,
);

test(
  "cron recovers an accepted occurrence after reset without resubmitting or losing its receipt",
  () =>
    run(
      Effect.scoped(
        Effect.gen(function* () {
          const directory = yield* Effect.acquireRelease(
            Effect.promise(() => mkdtemp(join(tmpdir(), "boxes-cron-accepted-"))),
            (path) => Effect.promise(() => rm(path, { recursive: true, force: true })),
          );
          const saved = yield* Effect.scoped(
            Effect.gen(function* () {
              const first = yield* connect(directory, "cirro-local-test-credential");
              yield* first.boxes.create({ id: "accepted", policy });
              const grant = yield* first.boxes.mintCapability("accepted", {
                permissions: ["read", "write", "execute", "manage"],
                expiresInSeconds: 3600,
              });
              const boxes = yield* make({
                url: (yield* Effect.promise(() => first.worker.ready)).toString(),
                token: Redacted.make(grant.token),
              });
              yield* boxes.action("accepted", { op: "contexts.create", id: "state" });
              const due = first.worker.time + 120000;
              const execution = {
                op: "javascript.evaluate",
                id: "tick",
                contextId: "state",
                expression: "42",
              } as const;
              yield* boxes.action("accepted", {
                op: "cron.schedule",
                id: "once",
                schedule: new Date(due).toISOString(),
                overlap: "allow",
                execution,
              });
              const key = "schedules/accepted/once.json";
              const digest = yield* Effect.promise(() =>
                crypto.subtle.digest(
                  "SHA-256",
                  new TextEncoder().encode(`${key}:${due}:${execution.id}`),
                ),
              );
              const id = `cron-${Buffer.from(digest).toString("hex").slice(0, 58)}`;
              yield* boxes.action("accepted", {
                op: "process.spawn",
                execution: { ...execution, id },
              });
              const objects = yield* Effect.promise(() => first.worker.objects);
              const object = yield* Effect.promise(() => objects.get(key));
              if (object === null) return yield* Effect.die("Missing schedule");
              const record = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(StoredCron))(
                yield* Effect.promise(() => object.text()),
              );
              yield* Effect.promise(() =>
                objects.put(
                  key,
                  Schema.encodeSync(Schema.fromJsonString(StoredCron))({
                    ...record,
                    pendingAt: due,
                  }),
                  { onlyIf: { etagMatches: object.etag }, customMetadata: object.customMetadata },
                ),
              );
              yield* boxes.action("accepted", { op: "contexts.reset", id: "state" });
              return { token: grant.token, due, id };
            }),
          );
          const second = yield* connect(directory, saved.token);
          const control = yield* Effect.promise(() => second.worker.control);
          yield* Effect.promise(() => control.schedules(saved.due));
          const job = yield* second.boxes.action("accepted", { op: "cron.get", id: "once" });
          expect([job.state, job.runCount, job.lastProcessId]).toEqual(["completed", 1, saved.id]);
          const message = yield* delivery(second.worker, "accepted", saved.id);
          yield* Effect.promise(() => control.deliver("executions", [message]));
          expect(
            (yield* second.boxes.action("accepted", { op: "process.get", id: saved.id })).status,
          ).toBe("failed");
          expect(
            (yield* second.boxes.action("accepted", { op: "contexts.get", id: "state" })).state,
          ).toBe("idle");
        }),
      ),
    ),
  10000,
);
