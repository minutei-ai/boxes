import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { Effect, Redacted, Schedule } from "effect";
import { FetchHttpClient } from "effect/http";
import { make } from "../src/sdk";
import { runtime } from "../tooling/worker-test";

test("host_tty.read waits for terminal input, expires finite waits and observes durable EOF", () =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const directory = yield* Effect.acquireRelease(
          Effect.promise(() => mkdtemp("/tmp/boxes-pty-session-")),
          (path) => Effect.promise(() => rm(path, { recursive: true, force: true })),
        );
        const worker = yield* Effect.acquireRelease(
          Effect.sync(() => runtime(directory, { consume: true, controlled: false })),
          (worker) => Effect.promise(() => worker.dispose()),
        );
        const url = (yield* Effect.promise(() => worker.ready)).toString();
        const admin = yield* make({ url, token: Redacted.make("cirro-local-test-credential") });
        yield* admin.create({
          id: "session",
          policy: {
            networkHosts: [],
            interruptBudget: 100000,
            memoryBytes: 8388608,
            maxOutputBytes: 1048576,
          },
        });
        const grant = yield* admin.mintCapability("session", {
          permissions: ["read", "execute"],
          expiresInSeconds: 60,
        });
        const client = yield* make({ url, token: Redacted.make(grant.token) });
        const outputPage = client.action("session", {
          op: "process.output.readLive",
          id: "interactive",
          after: null,
          maxBytes: 4096,
          maxEvents: 8,
        });
        const observed = Effect.fn("test.pty.observe")((marker: string) =>
          Effect.repeat(outputPage, {
            until: (page) =>
              Effect.succeed(
                Buffer.concat(
                  page.events.map((event) => Buffer.from(event.data, "base64")),
                ).includes(Buffer.from(marker)),
              ),
            schedule: Schedule.spaced("10 millis"),
          }).pipe(Effect.timeout("3 seconds")),
        );
        const source = Buffer.from(
          yield* Effect.promise(() => Bun.file("dist/wasi-pty-tty-read.wasm").arrayBuffer()),
        ).toString("base64");
        yield* client.action("session", {
          op: "process.spawn",
          stdinMode: "pty",
          execution: {
            op: "process.run",
            id: "interactive",
            language: "wasm",
            source,
          },
        });
        expect((yield* observed("timeout-ready\n")).state).toBe("running");
        yield* client.action("session", {
          op: "process.stdin.write",
          id: "interactive",
          offset: 0,
          content: "one",
          encoding: "utf8",
        });
        yield* observed("one-ready\n");
        yield* client.action("session", {
          op: "process.stdin.write",
          id: "interactive",
          offset: 3,
          content: "two",
          encoding: "utf8",
        });
        yield* observed("two-ready\n");
        yield* client.action("session", {
          op: "process.stdin.close",
          id: "interactive",
          offset: 6,
        });
        const record = yield* client.action("session", {
          op: "process.wait",
          id: "interactive",
          timeoutMs: 3000,
        });
        expect(record.status).toBe("exited");
        expect(record.output?.exitCode).toBe(0);
        expect(record.output?.stdout).toBe("timeout-ready\none-ready\ntwo-ready\neof-done\n");
        expect(record.output?.stderr).toBe("");
        yield* client.action("session", {
          op: "process.spawn",
          stdinMode: "pty",
          execution: { op: "process.run", id: "cancelled", language: "wasm", source },
        });
        const waiting = yield* client
          .action("session", {
            op: "process.output.readLive",
            id: "cancelled",
            after: null,
            maxBytes: 4096,
            maxEvents: 8,
          })
          .pipe(
            Effect.repeat({
              until: (page) => page.events.length > 0,
              schedule: Schedule.spaced("10 millis"),
            }),
            Effect.timeout("3 seconds"),
          );
        expect(waiting.state).toBe("running");
        yield* client.action("session", { op: "process.cancel", id: "cancelled" });
        expect(
          yield* client
            .action("session", { op: "process.wait", id: "cancelled", timeoutMs: 3000 })
            .pipe(Effect.flip),
        ).toMatchObject({ error: "ECANCELED" });
        const cancelled = yield* client.action("session", { op: "process.get", id: "cancelled" });
        expect(cancelled.status).toBe("cancelled");
        expect(cancelled.output?.stdout).toBe("timeout-ready\n");
        for (const probe of ["invalid", "rights"]) {
          yield* client.action("session", {
            op: "process.spawn",
            stdinMode: "pty",
            execution: {
              op: "process.run",
              id: probe,
              language: "wasm",
              source: Buffer.from(
                yield* Effect.promise(() =>
                  Bun.file(`dist/wasi-pty-tty-${probe}.wasm`).arrayBuffer(),
                ),
              ).toString("base64"),
            },
          });
          expect(
            yield* client
              .action("session", { op: "process.wait", id: probe, timeoutMs: 3000 })
              .pipe(Effect.flip),
          ).toMatchObject({ error: "EXECUTION_FAILED" });
          const failed = yield* client.action("session", { op: "process.get", id: probe });
          expect(failed.status).toBe("failed");
          expect(failed.output?.exitCode).toBeNull();
          expect(failed.output?.stdout).toBe(`${probe}-ready\r\n`);
        }
        expect(
          yield* client
            .action("neighbor", {
              op: "process.stdin.write",
              id: "interactive",
              offset: 6,
              content: "x",
              encoding: "utf8",
            })
            .pipe(Effect.flip),
        ).toMatchObject({ status: 401 });
        const readonly = yield* admin.mintCapability("session", {
          permissions: ["read"],
          expiresInSeconds: 60,
        });
        const reader = yield* make({ url, token: Redacted.make(readonly.token) });
        expect(
          yield* reader
            .action("session", {
              op: "process.stdin.write",
              id: "interactive",
              offset: 6,
              content: "x",
              encoding: "utf8",
            })
            .pipe(Effect.flip),
        ).toMatchObject({ status: 403 });
      }),
    ).pipe(
      Effect.provide(FetchHttpClient.layer),
      Effect.provideService(FetchHttpClient.RequestInit, { keepalive: false }),
    ),
  ));
