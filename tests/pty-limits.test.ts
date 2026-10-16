import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { Effect, Redacted, Schedule } from "effect";
import { FetchHttpClient } from "effect/http";
import { make } from "../src/sdk";
import { runtime } from "../tooling/worker-test";

test("PTY echo obeys the existing output budget and retains only previously acknowledged bytes on failure", () =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const directory = yield* Effect.acquireRelease(
          Effect.promise(() => mkdtemp("/tmp/boxes-pty-limit-")),
          (path) => Effect.promise(() => rm(path, { recursive: true, force: true })),
        );
        const worker = yield* Effect.acquireRelease(
          Effect.sync(() => runtime(directory, { consume: true, controlled: false })),
          (worker) => Effect.promise(() => worker.dispose()),
        );
        const url = (yield* Effect.promise(() => worker.ready)).toString();
        const admin = yield* make({ url, token: Redacted.make("cirro-local-test-credential") });
        yield* admin.create({
          id: "limited",
          policy: {
            networkHosts: [],
            interruptBudget: 100000,
            memoryBytes: 8388608,
            maxOutputBytes: 1024,
          },
        });
        const grant = yield* admin.mintCapability("limited", {
          permissions: ["read", "execute"],
          expiresInSeconds: 60,
        });
        const client = yield* make({ url, token: Redacted.make(grant.token) });
        yield* client.action("limited", {
          op: "process.spawn",
          stdinMode: "pty",
          execution: {
            op: "process.run",
            id: "echo",
            language: "wasm",
            source: Buffer.from(
              yield* Effect.promise(() => Bun.file("dist/wasi-pty-sink.wasm").arrayBuffer()),
            ).toString("base64"),
          },
        });
        const ready = yield* client
          .action("limited", {
            op: "process.output.readLive",
            id: "echo",
            after: null,
            maxBytes: 1024,
            maxEvents: 1,
          })
          .pipe(
            Effect.repeat({
              until: (page) => page.events.length > 0,
              schedule: Schedule.spaced("10 millis"),
            }),
            Effect.timeout("3 seconds"),
          );
        expect(Buffer.from(ready.events[0].data, "base64").toString()).toBe("ready\r\n");
        const appended = yield* client.action("limited", {
          op: "process.stdin.write",
          id: "echo",
          offset: 0,
          content: "x".repeat(1024) + "\n",
          encoding: "utf8",
        });
        expect(appended.total).toBe(1025);
        expect(
          yield* client
            .action("limited", { op: "process.wait", id: "echo", timeoutMs: 3000 })
            .pipe(Effect.flip),
        ).toMatchObject({ error: "EXECUTION_FAILED" });
        const record = yield* client.action("limited", { op: "process.get", id: "echo" });
        expect(record.status).toBe("failed");
        expect(record.output?.stdout).toBe("ready\r\n");
        expect(record.output?.exitCode).toBeNull();
        expect(
          (yield* client.action("limited", { op: "process.stdin.status", id: "echo" })).closed,
        ).toBe(true);
        const retained = yield* client.action("limited", {
          op: "process.output.read",
          id: "echo",
          after: null,
          maxBytes: 1024,
          maxEvents: 1,
        });
        expect(
          Buffer.concat(
            retained.events.map((event) => Buffer.from(event.data, "base64")),
          ).toString(),
        ).toBe("ready\r\n");
      }),
    ).pipe(
      Effect.provide(FetchHttpClient.layer),
      Effect.provideService(FetchHttpClient.RequestInit, { keepalive: false }),
    ),
  ));
