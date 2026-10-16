import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { Effect, Redacted, Schedule } from "effect";
import { FetchHttpClient } from "effect/http";
import { make, makeBinding } from "../src/sdk";
import { runtime } from "../tooling/worker-test";

for (const mode of [
  "handled",
  "restart",
  "default-int",
  "default-quit",
  "raw",
  "ignored",
  "masked",
  "family",
] as const) {
  test(`native PTY control keys preserve ${mode} signal semantics and byte ownership`, () =>
    Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const directory = yield* Effect.acquireRelease(
            Effect.promise(() => mkdtemp("/tmp/boxes-tty-signals-")),
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
          if (mode === "family") {
            yield* client.action("terminal", {
              op: "filesystem.writeFile",
              path: "/tmp/tty-child.wasm",
              encoding: "base64",
              content: Buffer.from(
                yield* Effect.promise(() =>
                  Bun.file("dist/wasi-tty-signals-child.wasm").arrayBuffer(),
                ),
              ).toString("base64"),
            });
            yield* client.action("terminal", {
              op: "filesystem.chmod",
              path: "/tmp/tty-child.wasm",
              mode: 493,
            });
          }
          yield* client.action("terminal", {
            op: "process.spawn",
            stdinMode: "pty",
            execution: {
              op: "process.run",
              id: "keys",
              language: "wasm",
              source: Buffer.from(
                yield* Effect.promise(() =>
                  Bun.file(`dist/wasi-tty-signals-${mode}.wasm`).arrayBuffer(),
                ),
              ).toString("base64"),
            },
          });
          const page = client.action("terminal", {
            op: "process.output.readLive",
            id: "keys",
            after: null,
            maxBytes: 4096,
            maxEvents: 32,
          });
          const observed = Effect.fn("test.ttySignals.observe")((marker: string) =>
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
          const write = Effect.fn("test.ttySignals.write")((offset: number, bytes: Uint8Array) =>
            client.action("terminal", {
              op: "process.stdin.write",
              id: "keys",
              offset,
              content: Buffer.from(bytes).toString("base64"),
              encoding: "base64",
            }),
          );
          const completedInput = yield* Effect.gen(function* () {
            if (mode === "family") {
              yield* observed("fg-ready\r\n");
              yield* observed("bg-ready\r\n");
              yield* write(0, Buffer.from([26]));
              yield* observed("stopped\r\n");
              yield* observed("continued\r\n");
              yield* write(1, Buffer.from([3]));
              return 2;
            }
            if (mode === "raw") yield* observed("ready\n");
            else yield* observed("ready\r\n");
            if (mode === "raw") {
              yield* write(0, Buffer.from([3, 28, 26, 255]));
              return 4;
            }
            if (mode === "default-int") {
              yield* write(0, Buffer.from([3]));
              return 1;
            }
            if (mode === "default-quit") {
              yield* write(0, Buffer.from([28]));
              return 1;
            }
            if (mode === "ignored" || mode === "masked") {
              yield* write(0, Buffer.from("discard\x03\x1c\x1akept\n"));
              return 15;
            }
            yield* write(0, Buffer.from("discard"));
            if (mode === "handled") {
              expect(
                yield* client
                  .action("terminal-other", {
                    op: "process.stdin.write",
                    id: "keys",
                    offset: 7,
                    content: "Aw==",
                    encoding: "base64",
                  })
                  .pipe(Effect.flip),
              ).toMatchObject({ status: 401 });
              const readonly = yield* admin.mintCapability("terminal", {
                permissions: ["read"],
                expiresInSeconds: 60,
              });
              const reader = yield* makeBinding(
                yield* Effect.promise(() => worker.service),
                Redacted.make(readonly.token),
              );
              expect(
                yield* reader
                  .action("terminal", {
                    op: "process.stdin.write",
                    id: "keys",
                    offset: 7,
                    content: "Aw==",
                    encoding: "base64",
                  })
                  .pipe(Effect.flip),
              ).toMatchObject({ status: 403 });
            }
            for (const [offset, key, marker] of [
              [7, 3, "interrupt"],
              [8, 28, "quit"],
              [9, 26, "suspend"],
            ] as const) {
              expect((yield* write(offset, Buffer.from([key]))).offset).toBe(offset + 1);
              yield* observed(`${marker}\r\n`);
              expect((yield* write(offset, Buffer.from([key]))).offset).toBe(offset + 1);
            }
            yield* write(10, Buffer.from("kept\n"));
            return 15;
          });
          const record = yield* client.action("terminal", {
            op: "process.wait",
            id: "keys",
            timeoutMs: 3000,
          });
          expect(record.status).toBe("exited");
          expect(record.output?.stderr).toBe("");
          if (mode === "default-int") {
            expect(record.output?.exitCode).toBe(130);
            expect(record.output?.stdout).toBe("ready\r\n");
          } else if (mode === "default-quit") {
            expect(record.output?.exitCode).toBe(131);
            expect(record.output?.stdout).toBe("ready\r\n");
          } else {
            expect(record.output?.exitCode).toBe(0);
            if (mode === "family") {
              expect(record.output?.stdout).toContain("fg-ready\r\n");
              expect(record.output?.stdout).toContain("bg-ready\r\n");
              expect(
                record.output?.stdout?.endsWith("stopped\r\ncontinued\r\nfamily-done\r\n"),
              ).toBe(true);
            } else if (mode === "raw") {
              const output = yield* client.action("terminal", {
                op: "process.output.read",
                id: "keys",
                after: null,
                maxBytes: 4096,
                maxEvents: 32,
              });
              expect(
                Buffer.concat(output.events.map((event) => Buffer.from(event.data, "base64"))),
              ).toEqual(
                Buffer.concat([
                  Buffer.from("ready\n"),
                  Buffer.from([3, 28, 26, 255]),
                  Buffer.from("done\n"),
                ]),
              );
            } else if (mode === "ignored") {
              expect(record.output?.stdout).toBe("ready\r\ndiscardkept\r\ndone\r\n");
            } else if (mode === "masked") {
              expect(record.output?.stdout).toBe(
                "ready\r\ndiscardkept\r\ninterrupt\r\nquit\r\nsuspend\r\nunmasked\r\ndone\r\n",
              );
            } else {
              expect(record.output?.stdout).toBe(
                "ready\r\ndiscardinterrupt\r\nquit\r\nsuspend\r\nkept\r\ndone\r\n",
              );
            }
          }
          expect(
            yield* client.action("terminal", { op: "process.stdin.status", id: "keys" }),
          ).toMatchObject({ offset: completedInput, total: completedInput, closed: true });
        }),
      ).pipe(
        Effect.provide(FetchHttpClient.layer),
        Effect.provideService(FetchHttpClient.RequestInit, { keepalive: false }),
      ),
    ));
}
