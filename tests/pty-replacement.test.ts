import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { Clock, Effect, Redacted, Schema } from "effect";
import { FetchHttpClient } from "effect/http";
import { ProcessDelivery, StoredRun } from "../src/contracts";
import { make } from "../src/sdk";
import { runtime } from "../tooling/worker-test";

test("PTY mode and closed queued input survive Worker replacement without duplicate guest entry", () =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const directory = yield* Effect.acquireRelease(
          Effect.promise(() => mkdtemp("/tmp/boxes-pty-replacement-")),
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
              id: "persisted",
              policy: {
                networkHosts: [],
                interruptBudget: 100000,
                memoryBytes: 8388608,
                maxOutputBytes: 1048576,
              },
            });
            const grant = yield* admin.mintCapability("persisted", {
              permissions: ["read", "execute"],
              expiresInSeconds: 60,
            });
            const client = yield* make({ url, token: Redacted.make(grant.token) });
            expect(
              yield* client
                .action("persisted", {
                  op: "process.spawn",
                  stdinMode: "pty",
                  execution: {
                    op: "process.run",
                    id: "unsupported",
                    language: "javascript",
                    source: "export default () => 42;",
                  },
                })
                .pipe(Effect.flip),
            ).toMatchObject({ status: 501, error: "UNSUPPORTED_RUNTIME" });
            expect(
              yield* client
                .action("persisted", { op: "process.get", id: "unsupported" })
                .pipe(Effect.flip),
            ).toMatchObject({ status: 404, error: "ENOENT" });
            yield* client.action("persisted", {
              op: "process.spawn",
              stdinMode: "pty",
              execution: {
                op: "process.run",
                id: "sink",
                language: "wasm",
                source: Buffer.from(
                  yield* Effect.promise(() => Bun.file("dist/wasi-pty-sink.wasm").arrayBuffer()),
                ).toString("base64"),
                stdin: { content: "seed\n", encoding: "utf8" },
              },
            });
            expect(
              (yield* client.action("persisted", { op: "process.get", id: "sink" })).status,
            ).toBe("queued");
            yield* client.action("persisted", {
              op: "process.stdin.write",
              id: "sink",
              offset: 5,
              content: "more\n",
              encoding: "utf8",
            });
            yield* client.action("persisted", {
              op: "process.stdin.close",
              id: "sink",
              offset: 10,
            });
            const objects = yield* Effect.promise(() => worker.objects);
            const key = "processes/persisted/sink.json";
            const stored = yield* Effect.promise(() => objects.get(key));
            if (stored === null) return yield* Effect.die("Missing queued PTY receipt");
            const record = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(StoredRun))(
              yield* Effect.promise(() => stored.text()),
            );
            expect(record.inputMode).toBe("pty");
            return { token: grant.token, key, eTag: stored.etag };
          }),
        );
        const completed = yield* Effect.scoped(
          Effect.gen(function* () {
            const worker = yield* Effect.acquireRelease(
              Effect.sync(() => runtime(directory, { controlled: false })),
              (worker) => Effect.promise(() => worker.dispose()),
            );
            const url = (yield* Effect.promise(() => worker.ready)).toString();
            const client = yield* make({ url, token: Redacted.make(retained.token) });
            const control = yield* Effect.promise(() => worker.control);
            const event = {
              id: "pty-first-entry",
              timestamp: new Date(yield* Clock.currentTimeMillis),
              attempts: 1,
              body: Schema.encodeSync(ProcessDelivery)({ key: retained.key, eTag: retained.eTag }),
            };
            const delivered = yield* Effect.promise(() => control.deliver("executions", [event]));
            expect(delivered.explicitAcks).toEqual([event.id]);
            const record = yield* client.action("persisted", { op: "process.get", id: "sink" });
            expect(record.status).toBe("exited");
            expect(record.output?.exitCode).toBe(0);
            expect(record.output?.stderr).toBe("");
            for (const marker of ["seed\r\n", "more\r\n", "ready\r\n", "done\r\n"])
              expect(record.output?.stdout.split(marker).length).toBe(2);
            const output = yield* client.action("persisted", {
              op: "process.output.read",
              id: "sink",
              after: null,
              maxBytes: 4096,
              maxEvents: 8,
            });
            expect(output.availability).toBe("retained");
            const objects = yield* Effect.promise(() => worker.objects);
            const saved = yield* Effect.promise(() => objects.head(retained.key));
            if (saved === null) return yield* Effect.die("Completed PTY receipt disappeared");
            const repeated = yield* Effect.promise(() =>
              control.deliver("executions", [{ ...event, id: "pty-duplicate", attempts: 2 }]),
            );
            expect(repeated.explicitAcks).toEqual(["pty-duplicate"]);
            expect((yield* Effect.promise(() => objects.head(retained.key)))?.etag).toBe(
              saved.etag,
            );
            expect(
              yield* client.action("persisted", {
                op: "process.output.read",
                id: "sink",
                after: null,
                maxBytes: 4096,
                maxEvents: 8,
              }),
            ).toEqual(output);
            return { record, output };
          }),
        );
        const replacement = yield* Effect.acquireRelease(
          Effect.sync(() => runtime(directory, { controlled: false })),
          (worker) => Effect.promise(() => worker.dispose()),
        );
        const url = (yield* Effect.promise(() => replacement.ready)).toString();
        const client = yield* make({ url, token: Redacted.make(retained.token) });
        expect(yield* client.action("persisted", { op: "process.get", id: "sink" })).toEqual(
          completed.record,
        );
        expect(
          yield* client.action("persisted", {
            op: "process.output.read",
            id: "sink",
            after: null,
            maxBytes: 4096,
            maxEvents: 8,
          }),
        ).toEqual(completed.output);
        expect(
          yield* client.action("persisted", { op: "process.stdin.status", id: "sink" }),
        ).toEqual({ offset: 10, total: 10, closed: true });
      }),
    ).pipe(
      Effect.provide(FetchHttpClient.layer),
      Effect.provideService(FetchHttpClient.RequestInit, { keepalive: false }),
    ),
  ));
