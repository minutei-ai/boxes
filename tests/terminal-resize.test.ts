import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { Clock, Effect, Redacted, Result, Schedule, Schema } from "effect";
import { FetchHttpClient } from "effect/http";
import { ProcessDelivery } from "../src/contracts";
import { make, makeBinding } from "../src/sdk";
import { runtime } from "../tooling/worker-test";

test("durable terminal resize wakes SIGWINCH after stdin EOF without losing revision or isolation", () =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const directory = yield* Effect.acquireRelease(
          Effect.promise(() => mkdtemp("/tmp/boxes-terminal-resize-")),
          (path) => Effect.promise(() => rm(path, { recursive: true, force: true })),
        );
        const worker = yield* Effect.acquireRelease(
          Effect.sync(() => runtime(directory, { consume: true, controlled: false })),
          (worker) => Effect.promise(() => worker.dispose()),
        );
        const url = (yield* Effect.promise(() => worker.ready)).toString();
        const admin = yield* make({ url, token: Redacted.make("cirro-local-test-credential") });
        yield* admin.create({
          id: "terminal",
          policy: {
            networkHosts: [],
            interruptBudget: 100000,
            memoryBytes: 8388608,
            maxOutputBytes: 1048576,
          },
        });
        const grant = yield* admin.mintCapability("terminal", {
          permissions: ["read", "execute"],
          expiresInSeconds: 60,
        });
        const client = yield* makeBinding(
          yield* Effect.promise(() => worker.service),
          Redacted.make(grant.token),
        );
        yield* client.action("terminal", {
          op: "process.spawn",
          stdinMode: "pty",
          execution: {
            op: "process.run",
            id: "live",
            language: "wasm",
            source: Buffer.from(
              yield* Effect.promise(() => Bun.file("dist/wasi-pty-resize.wasm").arrayBuffer()),
            ).toString("base64"),
          },
        });
        const output = client.action("terminal", {
          op: "process.output.readLive",
          id: "live",
          after: null,
          maxBytes: 4096,
          maxEvents: 16,
        });
        const observed = Effect.fn("test.terminal.observe")((marker: string) =>
          Effect.repeat(output, {
            until: (page) =>
              Effect.succeed(
                Buffer.concat(
                  page.events.map((event) => Buffer.from(event.data, "base64")),
                ).includes(Buffer.from(marker)),
              ),
            schedule: Schedule.spaced("10 millis"),
          }).pipe(Effect.timeout("3 seconds")),
        );
        yield* observed("ready\n");
        expect(
          yield* client.action("terminal", { op: "process.terminal.status", id: "live" }),
        ).toEqual({ cols: 80, rows: 24, revision: 0 });
        yield* client.action("terminal", { op: "process.stdin.close", id: "live", offset: 0 });
        yield* observed("eof-ready\n");
        const readonly = yield* admin.mintCapability("terminal", {
          permissions: ["read"],
          expiresInSeconds: 60,
        });
        const reader = yield* makeBinding(
          yield* Effect.promise(() => worker.service),
          Redacted.make(readonly.token),
        );
        expect(
          yield* reader.action("terminal", { op: "process.terminal.status", id: "live" }),
        ).toEqual({ cols: 80, rows: 24, revision: 0 });
        expect(
          yield* reader
            .action("terminal", {
              op: "process.terminal.resize",
              id: "live",
              cols: 120,
              rows: 40,
              revision: 0,
            })
            .pipe(Effect.flip),
        ).toMatchObject({ status: 403 });
        expect(
          yield* client
            .action("neighbor", {
              op: "process.terminal.resize",
              id: "live",
              cols: 120,
              rows: 40,
              revision: 0,
            })
            .pipe(Effect.flip),
        ).toMatchObject({ status: 401 });
        const objects = yield* Effect.promise(() => worker.objects);
        const before = yield* Effect.promise(() =>
          objects.head("process-input/terminal/live.json"),
        );
        const malformed = yield* Effect.tryPromise(() =>
          fetch(new URL("/v1/sandboxes/terminal/action", url), {
            method: "POST",
            keepalive: false,
            headers: { authorization: `Bearer ${grant.token}`, "content-type": "application/json" },
            body: '{"op":"process.terminal.resize","id":"live","cols":0,"rows":40,"revision":0}',
          }),
        );
        expect(malformed.status).toBe(400);
        yield* Effect.promise(() => malformed.text());
        expect(
          (yield* Effect.promise(() => objects.head("process-input/terminal/live.json")))?.etag,
        ).toBe(before?.etag);
        const resized = yield* Effect.forEach(
          [0, 1],
          () =>
            client
              .action("terminal", {
                op: "process.terminal.resize",
                id: "live",
                cols: 120,
                rows: 40,
                revision: 0,
              })
              .pipe(Effect.result),
          { concurrency: 2 },
        );
        expect(resized.filter(Result.isSuccess)).toHaveLength(1);
        const rejected = resized.filter(Result.isFailure);
        expect(rejected).toHaveLength(1);
        expect(rejected[0].failure).toMatchObject({ status: 409 });
        yield* observed("after-one\n");
        const revision = yield* client.action("terminal", {
          op: "process.terminal.status",
          id: "live",
        });
        expect(revision).toEqual({ cols: 120, rows: 40, revision: 1 });
        const same = yield* Effect.promise(() => objects.head("process-input/terminal/live.json"));
        expect(
          yield* client.action("terminal", {
            op: "process.terminal.resize",
            id: "live",
            ...revision,
          }),
        ).toEqual(revision);
        expect(
          (yield* Effect.promise(() => objects.head("process-input/terminal/live.json")))?.etag,
        ).toBe(same?.etag);
        const agent = yield* client.action("terminal", {
          op: "process.run",
          id: "resize-agent",
          language: "typescript",
          source:
            'export default async ({ tools }) => { const before = await tools.call({ op: "process.terminal.status", id: "live" }); return await tools.call({ op: "process.terminal.resize", id: "live", cols: 100, rows: 30, revision: before.revision }); }',
        });
        expect(agent.status).toBe("exited");
        expect(agent.output?.result).toEqual({ cols: 100, rows: 30, revision: 2 });
        const record = yield* client.action("terminal", {
          op: "process.wait",
          id: "live",
          timeoutMs: 3000,
        });
        expect(record.status).toBe("exited");
        expect(record.output?.exitCode).toBe(0);
        expect(record.output?.stdout).toBe("ready\neof-ready\nwinch\nafter-one\nwinch\ndone\n");
        expect(
          yield* client.action("terminal", { op: "process.terminal.status", id: "live" }),
        ).toEqual({ cols: 100, rows: 30, revision: 2 });
        expect(
          yield* client
            .action("terminal", {
              op: "process.terminal.resize",
              id: "live",
              cols: 101,
              rows: 31,
              revision: 2,
            })
            .pipe(Effect.flip),
        ).toMatchObject({ status: 409 });
      }),
    ).pipe(
      Effect.provide(FetchHttpClient.layer),
      Effect.provideService(FetchHttpClient.RequestInit, { keepalive: false }),
    ),
  ));

test("queued terminal geometry survives Worker replacement and is installed before the first guest instruction", () =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const directory = yield* Effect.acquireRelease(
          Effect.promise(() => mkdtemp("/tmp/boxes-terminal-initial-")),
          (path) => Effect.promise(() => rm(path, { recursive: true, force: true })),
        );
        const retained = yield* Effect.scoped(
          Effect.gen(function* () {
            const worker = yield* Effect.acquireRelease(
              Effect.sync(() => runtime(directory, { controlled: false })),
              (worker) => Effect.promise(() => worker.dispose()),
            );
            const url = (yield* Effect.promise(() => worker.ready)).toString();
            const admin = yield* make({ url, token: Redacted.make("cirro-local-test-credential") });
            yield* admin.create({
              id: "initial",
              policy: {
                networkHosts: [],
                interruptBudget: 100000,
                memoryBytes: 8388608,
                maxOutputBytes: 1048576,
              },
            });
            const grant = yield* admin.mintCapability("initial", {
              permissions: ["read", "execute"],
              expiresInSeconds: 60,
            });
            const client = yield* make({ url, token: Redacted.make(grant.token) });
            yield* client.action("initial", {
              op: "process.spawn",
              stdinMode: "pty",
              execution: {
                op: "process.run",
                id: "job",
                language: "wasm",
                source: Buffer.from(
                  yield* Effect.promise(() =>
                    Bun.file("dist/wasi-pty-resize-initial.wasm").arrayBuffer(),
                  ),
                ).toString("base64"),
              },
            });
            const objects = yield* Effect.promise(() => worker.objects);
            yield* Effect.promise(() => objects.delete("process-input/initial/job.json"));
            const readonly = yield* admin.mintCapability("initial", {
              permissions: ["read"],
              expiresInSeconds: 60,
            });
            const reader = yield* make({ url, token: Redacted.make(readonly.token) });
            expect(
              yield* reader
                .action("initial", { op: "process.terminal.status", id: "job" })
                .pipe(Effect.flip),
            ).toMatchObject({ status: 403 });
            expect(
              yield* Effect.promise(() => objects.head("process-input/initial/job.json")),
            ).toBeNull();
            expect(
              yield* client.action("initial", { op: "process.terminal.status", id: "job" }),
            ).toEqual({ cols: 80, rows: 24, revision: 0 });
            const resize = client.action("initial", {
              op: "process.terminal.resize",
              id: "job",
              cols: 132,
              rows: 45,
              revision: 0,
            });
            const close = client.action("initial", {
              op: "process.stdin.close",
              id: "job",
              offset: 0,
            });
            const concurrent = yield* Effect.all(
              [resize.pipe(Effect.result), close.pipe(Effect.result)],
              { concurrency: 2 },
            );
            for (const result of concurrent) {
              if (result._tag === "Failure") expect(result.failure).toMatchObject({ status: 409 });
            }
            if (Result.isFailure(concurrent[0])) {
              expect(
                yield* client.action("initial", { op: "process.terminal.status", id: "job" }),
              ).toEqual({ cols: 80, rows: 24, revision: 0 });
              yield* resize;
            }
            if (Result.isFailure(concurrent[1])) {
              expect(
                yield* client.action("initial", { op: "process.stdin.status", id: "job" }),
              ).toEqual({ offset: 0, total: 0, closed: false });
              yield* close;
            }
            expect(
              yield* client.action("initial", { op: "process.terminal.status", id: "job" }),
            ).toEqual({ cols: 132, rows: 45, revision: 1 });
            expect(
              yield* client.action("initial", { op: "process.stdin.status", id: "job" }),
            ).toEqual({ offset: 0, total: 0, closed: true });
            const object = yield* Effect.promise(() => objects.head("processes/initial/job.json"));
            if (object === null) return yield* Effect.die("Missing queued terminal");
            return { token: grant.token, key: object.key, eTag: object.etag };
          }),
        );
        const worker = yield* Effect.acquireRelease(
          Effect.sync(() => runtime(directory, { controlled: false })),
          (worker) => Effect.promise(() => worker.dispose()),
        );
        const client = yield* make({
          url: (yield* Effect.promise(() => worker.ready)).toString(),
          token: Redacted.make(retained.token),
        });
        expect(
          yield* client.action("initial", { op: "process.terminal.status", id: "job" }),
        ).toEqual({ cols: 132, rows: 45, revision: 1 });
        const control = yield* Effect.promise(() => worker.control);
        const timestamp = new Date(yield* Clock.currentTimeMillis);
        yield* Effect.promise(() =>
          control.deliver("executions", [
            {
              id: "initial-size",
              timestamp,
              attempts: 1,
              body: Schema.encodeSync(ProcessDelivery)({ key: retained.key, eTag: retained.eTag }),
            },
          ]),
        );
        const record = yield* client.action("initial", { op: "process.get", id: "job" });
        expect(record.status).toBe("exited");
        expect(record.output?.exitCode).toBe(0);
        expect(record.output?.stdout).toBe("initial132x45\r\n");
      }),
    ).pipe(
      Effect.provide(FetchHttpClient.layer),
      Effect.provideService(FetchHttpClient.RequestInit, { keepalive: false }),
    ),
  ));
