import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { Effect, Redacted, Schedule } from "effect";
import { FetchHttpClient } from "effect/http";
import { make, makeBinding } from "../src/sdk";
import { runtime } from "../tooling/worker-test";

for (const mode of ["parent", "pair"] as const) {
  test(`native terminal ${mode} shares foreground through aliases and enforces session ownership`, () =>
    Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const directory = yield* Effect.acquireRelease(
            Effect.promise(() => mkdtemp("/tmp/boxes-tty-foreground-")),
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
            permissions: ["read", "write", "execute"],
            expiresInSeconds: 60,
          });
          const client = yield* makeBinding(
            yield* Effect.promise(() => worker.service),
            Redacted.make(grant.token),
          );
          const source = Buffer.from(
            yield* Effect.promise(() =>
              Bun.file(`dist/wasi-tty-foreground-${mode}.wasm`).arrayBuffer(),
            ),
          ).toString("base64");
          if (mode === "pair") {
            const record = yield* client.action("terminal", {
              op: "process.run",
              id: "pair",
              language: "wasm",
              source,
            });
            expect(record.status).toBe("exited");
            expect(record.output?.exitCode).toBe(0);
            expect(record.output?.stdout).toBe("interrupt\npair-done\n");
            return;
          }
          for (const [name, artifact] of [
            ["owned", "child"],
            ["foreign", "foreign"],
          ] as const) {
            yield* client.action("terminal", {
              op: "filesystem.writeFile",
              path: `/tmp/tty-${name}.wasm`,
              encoding: "base64",
              content: Buffer.from(
                yield* Effect.promise(() =>
                  Bun.file(`dist/wasi-tty-foreground-${artifact}.wasm`).arrayBuffer(),
                ),
              ).toString("base64"),
            });
            yield* client.action("terminal", {
              op: "filesystem.chmod",
              path: `/tmp/tty-${name}.wasm`,
              mode: 493,
            });
          }
          yield* client.action("terminal", {
            op: "process.spawn",
            stdinMode: "pty",
            execution: { op: "process.run", id: "owned", language: "wasm", source },
          });
          const page = client.action("terminal", {
            op: "process.output.readLive",
            id: "owned",
            after: null,
            maxBytes: 4096,
            maxEvents: 32,
          });
          const observed = Effect.fn("test.foreground.observe")((marker: string) =>
            Effect.repeat(page, {
              until: (page) =>
                Effect.succeed(
                  Buffer.concat(
                    page.events.map((event) => Buffer.from(event.data, "base64")),
                  ).includes(Buffer.from(marker)),
                ),
              schedule: Schedule.spaced("10 millis"),
            }).pipe(Effect.timeout("3 seconds")),
          );
          yield* observed("owned\r\n");
          yield* observed("child-ready\r\n");
          yield* client.action("terminal", {
            op: "process.terminal.resize",
            id: "owned",
            cols: 120,
            rows: 40,
            revision: 0,
          });
          yield* observed("winch\r\n");
          yield* client.action("terminal", {
            op: "process.stdin.write",
            id: "owned",
            offset: 0,
            content: "Gg==",
            encoding: "base64",
          });
          yield* observed("continued\r\n");
          yield* client.action("terminal", {
            op: "process.stdin.write",
            id: "owned",
            offset: 1,
            content: "Aw==",
            encoding: "base64",
          });
          yield* observed("reclaimed\r\n");
          yield* client.action("terminal", {
            op: "process.stdin.write",
            id: "owned",
            offset: 2,
            content: "Aw==",
            encoding: "base64",
          });
          const result = yield* client.action("terminal", {
            op: "process.wait",
            id: "owned",
            timeoutMs: 3000,
          });
          expect(result.status).toBe("exited");
          expect(result.output?.exitCode).toBe(0);
          expect(result.output?.stderr).toBe("");
          expect(result.output?.stdout).toContain("child-ready\r\n");
          expect(result.output?.stdout).toContain("owned\r\n");
          expect(
            result.output?.stdout?.endsWith(
              "winch\r\nstopped\r\ncontinued\r\nreclaimed\r\ninterrupt\r\ndone\r\n",
            ),
          ).toBe(true);
          expect(
            yield* client.action("terminal", { op: "process.stdin.status", id: "owned" }),
          ).toEqual({ offset: 3, total: 3, closed: true });
        }),
      ).pipe(
        Effect.provide(FetchHttpClient.layer),
        Effect.provideService(FetchHttpClient.RequestInit, { keepalive: false }),
      ),
    ));
}
