import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { Effect, Redacted, Schedule } from "effect";
import { FetchHttpClient } from "effect/http";
import { make } from "../src/sdk";
import { runtime } from "../tooling/worker-test";

test("native WASI PTY preserves canonical lines, raw bytes, backpressure and alias lifetime", () =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const directory = yield* Effect.acquireRelease(
          Effect.promise(() => mkdtemp("/tmp/boxes-pty-")),
          (path) => Effect.promise(() => rm(path, { recursive: true, force: true })),
        );
        const worker = yield* Effect.acquireRelease(
          Effect.sync(() => runtime(directory, { controlled: false })),
          (worker) => Effect.promise(() => worker.dispose()),
        );
        const url = (yield* Effect.promise(() => worker.ready)).toString();
        const admin = yield* make({ url, token: Redacted.make("cirro-local-test-credential") });
        yield* admin.create({
          id: "pty",
          policy: {
            networkHosts: [],
            interruptBudget: 1000,
            memoryBytes: 8388608,
            maxOutputBytes: 1048576,
          },
        });
        const grant = yield* admin.mintCapability("pty", {
          permissions: ["read", "execute"],
          expiresInSeconds: 60,
        });
        const client = yield* make({ url, token: Redacted.make(grant.token) });
        const source = Buffer.from(
          yield* Effect.promise(() => Bun.file("dist/wasi-pty-normal.wasm").arrayBuffer()),
        ).toString("base64");
        const record = yield* client.action("pty", {
          op: "process.run",
          id: "terminal",
          language: "wasm",
          source,
        });
        expect(record.status).toBe("exited");
        expect(record.output?.exitCode).toBe(0);
        expect(record.output?.result).toBe(0);
        const writer = yield* admin.mintCapability("pty", {
          permissions: ["read", "write", "execute"],
          expiresInSeconds: 60,
        });
        const installer = yield* make({ url, token: Redacted.make(writer.token) });
        yield* installer.action("pty", {
          op: "filesystem.writeFile",
          path: "/tmp/pty-child.wasm",
          encoding: "base64",
          content: Buffer.from(
            yield* Effect.promise(() => Bun.file("dist/wasi-pty-child.wasm").arrayBuffer()),
          ).toString("base64"),
        });
        yield* installer.action("pty", {
          op: "filesystem.chmod",
          path: "/tmp/pty-child.wasm",
          mode: 493,
        });
        const parent = yield* client.action("pty", {
          op: "process.run",
          id: "parent",
          language: "wasm",
          source: Buffer.from(
            yield* Effect.promise(() => Bun.file("dist/wasi-pty-parent.wasm").arrayBuffer()),
          ).toString("base64"),
        });
        expect(parent.status).toBe("exited");
        expect(parent.output?.exitCode).toBe(0);
        expect(parent.output?.result).toBe(0);
        expect(parent.output?.stdout).toBe("hello\r\nout:hello\r\nerr\r\n");
      }),
    ).pipe(
      Effect.provide(FetchHttpClient.layer),
      Effect.provideService(FetchHttpClient.RequestInit, { keepalive: false }),
    ),
  ));

test("queued PTY waits without fake EOF and cancellation retains acknowledged output", () =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const directory = yield* Effect.acquireRelease(
          Effect.promise(() => mkdtemp("/tmp/boxes-pty-cancel-")),
          (path) => Effect.promise(() => rm(path, { recursive: true, force: true })),
        );
        const worker = yield* Effect.acquireRelease(
          Effect.sync(() => runtime(directory, { consume: true, controlled: false })),
          (worker) => Effect.promise(() => worker.dispose()),
        );
        const url = (yield* Effect.promise(() => worker.ready)).toString();
        const admin = yield* make({ url, token: Redacted.make("cirro-local-test-credential") });
        yield* admin.create({
          id: "pty-wait",
          policy: {
            networkHosts: [],
            interruptBudget: 1000,
            memoryBytes: 8388608,
            maxOutputBytes: 1048576,
          },
        });
        const grant = yield* admin.mintCapability("pty-wait", {
          permissions: ["read", "execute"],
          expiresInSeconds: 60,
        });
        const client = yield* make({ url, token: Redacted.make(grant.token) });
        yield* client.action("pty-wait", {
          op: "process.spawn",
          stdinMode: "pty",
          execution: {
            op: "process.run",
            id: "waiting",
            language: "wasm",
            source: Buffer.from(
              yield* Effect.promise(() => Bun.file("dist/wasi-pty-blocked.wasm").arrayBuffer()),
            ).toString("base64"),
          },
        });
        const observed = yield* client
          .action("pty-wait", {
            op: "process.output.readLive",
            id: "waiting",
            after: null,
            maxBytes: 4096,
            maxEvents: 1,
          })
          .pipe(
            Effect.repeat({
              until: (page) => page.events.length > 0,
              schedule: Schedule.spaced("10 millis"),
            }),
            Effect.timeout("3 seconds"),
          );
        expect(observed.state).toBe("running");
        expect(Buffer.from(observed.events[0].data, "base64").toString()).toBe(
          "waiting for terminal",
        );
        expect(
          yield* client
            .action("pty-wait", { op: "process.wait", id: "waiting", timeoutMs: 0 })
            .pipe(Effect.flip),
        ).toMatchObject({ error: "ETIMEDOUT" });
        yield* client.action("pty-wait", { op: "process.cancel", id: "waiting" });
        expect(
          yield* client
            .action("pty-wait", { op: "process.wait", id: "waiting", timeoutMs: 3000 })
            .pipe(Effect.flip),
        ).toMatchObject({ error: "ECANCELED" });
        const record = yield* client.action("pty-wait", { op: "process.get", id: "waiting" });
        expect(record.status).toBe("cancelled");
        expect(record.output?.stdout).toBe("waiting for terminal");
        expect(
          yield* client.action("pty-wait", {
            op: "process.terminal.attributes",
            id: "waiting",
            timeoutMs: 0,
          }),
        ).toMatchObject({
          desired: { attributes: null, revision: 0 },
          observed: { revision: 0, attributes: { icanon: true, echo: true, isig: true } },
          settled: true,
        });
      }),
    ).pipe(
      Effect.provide(FetchHttpClient.layer),
      Effect.provideService(FetchHttpClient.RequestInit, { keepalive: false }),
    ),
  ));
