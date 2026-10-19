import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Effect, Redacted, Schedule } from "effect";
import { FetchHttpClient } from "effect/http";
import { make } from "../src/sdk";
import { runtime } from "../tooling/worker-test";

test(
  "queued PTY accepts canonical and raw input through the SDK and persists one byte-ordered output stream",
  () =>
    Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const directory = yield* Effect.acquireRelease(
            Effect.promise(() => mkdtemp(join(tmpdir(), "boxes-pty-session-"))),
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
          yield* client.action("session", {
            op: "process.spawn",
            stdinMode: "pty",
            execution: {
              op: "process.run",
              id: "interactive",
              language: "wasm",
              source: Buffer.from(
                yield* Effect.promise(() => Bun.file("dist/wasi-pty-session.wasm").arrayBuffer()),
              ).toString("base64"),
            },
          });
          expect((yield* observed("ready\r\n")).state).toBe("running");
          const first = {
            op: "process.stdin.write",
            id: "interactive",
            offset: 0,
            content: "hel",
            encoding: "utf8",
          } as const;
          expect((yield* client.action("session", first)).offset).toBe(3);
          yield* observed("ready\r\nhel");
          expect((yield* client.action("session", first)).offset).toBe(3);
          yield* client.action("session", {
            op: "process.stdin.write",
            id: "interactive",
            offset: 3,
            content: "lo\r",
            encoding: "utf8",
          });
          const cooked = yield* observed("raw\n");
          expect(
            Buffer.concat(
              cooked.events.map((event) => Buffer.from(event.data, "base64")),
            ).toString(),
          ).toBe("ready\r\nhello\r\nout:hello\r\nerr\r\nraw\n");
          const raw = Buffer.from([0, 3, 4, 13, 10, 127, 255]);
          yield* client.action("session", {
            op: "process.stdin.write",
            id: "interactive",
            offset: 6,
            content: raw.toString("base64"),
            encoding: "base64",
          });
          yield* observed("cooked\r\n");
          yield* client.action("session", {
            op: "process.stdin.write",
            id: "interactive",
            offset: 13,
            content: "tail",
            encoding: "utf8",
          });
          yield* observed("cooked\r\ntail");
          yield* client.action("session", {
            op: "process.stdin.close",
            id: "interactive",
            offset: 17,
          });
          const record = yield* client.action("session", {
            op: "process.wait",
            id: "interactive",
            timeoutMs: 3000,
          });
          expect(record.status).toBe("exited");
          expect(record.output?.exitCode).toBe(0);
          expect(record.output?.stderr).toBe("");
          const output = yield* client.action("session", {
            op: "process.output.read",
            id: "interactive",
            after: null,
            maxBytes: 4096,
            maxEvents: 8,
          });
          expect(output.hasMore).toBe(false);
          expect(output.events.every((event) => event.stream === "stdout")).toBe(true);
          expect(
            Buffer.concat(output.events.map((event) => Buffer.from(event.data, "base64"))),
          ).toEqual(
            Buffer.concat([
              Buffer.from("ready\r\nhello\r\nout:hello\r\nerr\r\nraw\nraw:"),
              raw,
              Buffer.from("cooked\r\ntaildone\r\n"),
            ]),
          );
          expect(
            yield* client
              .action("neighbor", {
                op: "process.stdin.write",
                id: "interactive",
                offset: 17,
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
                offset: 17,
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
    ),
  20000,
);
