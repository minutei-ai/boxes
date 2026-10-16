import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { Clock, Effect, Redacted, Schedule } from "effect";
import { FetchHttpClient } from "effect/http";
import { make } from "../src/sdk";
import { runtime } from "../tooling/worker-test";

test(
  "a cursor reply after idle reaches the guest within its real two-second deadline",
  () =>
    Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const directory = yield* Effect.acquireRelease(
            Effect.promise(() => mkdtemp("/tmp/boxes-cursor-")),
            (path) => Effect.promise(() => rm(path, { recursive: true, force: true })),
          );
          const worker = yield* Effect.acquireRelease(
            Effect.sync(() => runtime(directory, { consume: true, controlled: false })),
            (worker) => Effect.promise(() => worker.dispose()),
          );
          const url = (yield* Effect.promise(() => worker.ready)).toString();
          const admin = yield* make({ url, token: Redacted.make("cirro-local-test-credential") });
          yield* admin.create({
            id: "cursor",
            policy: {
              networkHosts: [],
              interruptBudget: 100000,
              memoryBytes: 8388608,
              maxOutputBytes: 1048576,
            },
          });
          const grant = yield* admin.mintCapability("cursor", {
            permissions: ["read", "execute"],
            expiresInSeconds: 60,
          });
          const client = yield* make({ url, token: Redacted.make(grant.token) });
          const source = Buffer.from(
            yield* Effect.promise(() => Bun.file("dist/wasi-pty-tty-cursor.wasm").arrayBuffer()),
          ).toString("base64");
          yield* client.action("cursor", {
            op: "process.spawn",
            stdinMode: "pty",
            execution: { op: "process.run", id: "cursor", language: "wasm", source },
          });
          yield* client
            .action("cursor", {
              op: "process.output.readLive",
              id: "cursor",
              after: null,
              maxBytes: 4096,
              maxEvents: 8,
            })
            .pipe(
              Effect.repeat({
                until: (page) =>
                  Effect.succeed(
                    Buffer.concat(
                      page.events.map((event) => Buffer.from(event.data, "base64")),
                    ).includes(Buffer.from("\x1b[6n")),
                  ),
                schedule: Schedule.spaced("10 millis"),
              }),
              Effect.timeout("6 seconds"),
            );
          const observedAt = yield* Clock.currentTimeMillis;
          yield* Effect.sleep("1500 millis");
          const receipt = yield* client.action("cursor", {
            op: "process.stdin.write",
            id: "cursor",
            offset: 0,
            content: "\x1b[1;1R",
            encoding: "utf8",
          });
          const acknowledgedAfter = (yield* Clock.currentTimeMillis) - observedAt;
          expect(receipt.offset).toBe(6);
          expect(acknowledgedAfter).toBeLessThan(2000);
          const record = yield* client.action("cursor", {
            op: "process.wait",
            id: "cursor",
            timeoutMs: 3000,
          });
          expect(record.output?.exitCode).toBe(0);
          expect(record.output?.stdout).toBe("\x1b[6ncursor-ready\n");
          expect(record.output?.stderr).toBe("");
        }),
      ).pipe(
        Effect.provide(FetchHttpClient.layer),
        Effect.provideService(FetchHttpClient.RequestInit, { keepalive: false }),
      ),
    ),
  15000,
);
