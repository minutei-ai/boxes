import { defaultSoftware } from "../src/default-software";
import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { Effect, Redacted, Schedule } from "effect";
import { FetchHttpClient } from "effect/http";
import { make } from "../src/sdk";
import { runtime } from "../tooling/worker-test";
import { downloadSoftware } from "../tooling/software-artifacts";

test.each(["minimal", "reedline"])(
  "published Brush %s shell executes interactive commands through a queued PTY",
  (backend) =>
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
            permissions: ["read", "write", "execute"],
            expiresInSeconds: 60,
          });
          const client = yield* make({ url, token: Redacted.make(grant.token) });
          const installation = yield* admin.mintCapability("session", {
            permissions: ["read", "write", "manage"],
            expiresInSeconds: 60,
          });
          const installer = yield* make({ url, token: Redacted.make(installation.token) });
          const software = defaultSoftware[0];
          const bytes = yield* downloadSoftware(software);
          yield* client.action("session", {
            op: "filesystem.writeFile",
            path: "/tmp/sh.aospkg",
            content: Buffer.from(bytes).toString("base64"),
            encoding: "base64",
          });
          yield* installer.action("session", {
            op: "software.install",
            source: { path: "/tmp/sh.aospkg", digest: `sha256:${software.digest}` },
          });
          const outputPage = client.action("session", {
            op: "process.output.readLive",
            id: "interactive",
            after: null,
            maxBytes: 65536,
            maxEvents: 128,
          });
          const terminal = { offset: 0, queries: 0 };
          const input = Effect.fn("test.terminal.input")(function* (content: string) {
            const receipt = yield* client.action("session", {
              op: "process.stdin.write",
              id: "interactive",
              offset: terminal.offset,
              content,
              encoding: "utf8",
            });
            terminal.offset = receipt.offset;
          });
          const readOutput = Effect.fn("test.terminal.read")(function* () {
            const page = yield* outputPage;
            const bytes = Buffer.concat(
              page.events.map((event) => Buffer.from(event.data, "base64")),
            ).toString();
            const queries = bytes.match(/\x1b\[6n/g)?.length ?? 0;
            if (queries > terminal.queries) {
              yield* input("\x1b[1;1R".repeat(queries - terminal.queries));
              terminal.queries = queries;
            }
            return page;
          });
          const observed = Effect.fn("test.terminal.observe")((marker: string, count = 1) =>
            Effect.repeat(readOutput(), {
              until: (page) =>
                Effect.succeed(
                  Buffer.concat(page.events.map((event) => Buffer.from(event.data, "base64")))
                    .toString()
                    .split(marker).length -
                    1 >=
                    count,
                ),
              schedule: Schedule.spaced("10 millis"),
            }).pipe(Effect.timeout("3 seconds")),
          );
          yield* client.action("session", {
            op: "process.spawn",
            stdinMode: "pty",
            execution: {
              op: "process.execFile",
              id: "interactive",
              command: "sh",
              args: ["--input-backend", backend, "-i"],
              env: { TERM: "xterm-256color", PS1: "BOXES$ " },
            },
          });
          expect((yield* observed("BOXES$ ")).state).toBe("running");
          if (backend === "reedline")
            expect(
              yield* client.action("session", {
                op: "process.terminal.resize",
                id: "interactive",
                cols: 120,
                rows: 40,
                revision: 0,
              }),
            ).toEqual({ cols: 120, rows: 40, revision: 1 });
          const command = "printf 'output:%s\\n' hello; printf marker > /tmp/interactive-marker\r";
          if (backend === "reedline")
            yield* input("\x1b[200~" + command.slice(0, -1) + "\x1b[201~\r");
          else yield* input(command);
          yield* observed("output:hello");
          if (backend === "reedline") {
            yield* input("\x1b[A\r");
            yield* observed("output:hello", 2);
            yield* input("\x1b[A\x15\x1b[200~printf 'edited:%s\\n' yes\x1b[201~\r");
            yield* observed("edited:yes");
          }
          yield* input("exit 7\r");
          yield* readOutput().pipe(
            Effect.repeat({
              until: (page) => page.state === "exited" || page.state === "failed",
              schedule: Schedule.spaced("10 millis"),
            }),
            Effect.timeout("3 seconds"),
          );
          const record = yield* client.action("session", {
            op: "process.wait",
            id: "interactive",
            timeoutMs: 3000,
          });
          expect(record.status).toBe("exited");
          expect(record.output?.exitCode).toBe(7);
          expect(record.output?.stdout).toContain("output:hello");
          const file = yield* client.action("session", {
            op: "filesystem.readFile",
            path: "/tmp/interactive-marker",
          });
          expect(Buffer.from(file.content, file.encoding).toString()).toBe("marker");
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
    ),
  30000,
);
