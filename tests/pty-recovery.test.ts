import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { Clock, Effect, Match, Redacted, Schema } from "effect";
import { FetchHttpClient } from "effect/http";
import { ExecutionCheckpoint, HeapSnapshot, ProcessDelivery, StoredRun } from "../src/contracts";
import { make } from "../src/sdk";
import { runtime } from "../tooling/worker-test";

for (const mode of [
  "cooked",
  "raw",
  "raw-owner",
  "termios",
  "family",
  "cancelled",
  "geometry",
  "geometry-restart",
  "signals",
  "foreground",
  "delayed",
] as const) {
  test(`active ${mode} PTY preserves its checkpointed state across Worker replacement`, () =>
    Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const directory = yield* Effect.acquireRelease(
            Effect.promise(() => mkdtemp("/tmp/boxes-pty-recovery-")),
            (path) => Effect.promise(() => rm(path, { recursive: true, force: true })),
          );
          const retained = yield* Effect.scoped(
            Effect.gen(function* () {
              const worker = yield* Effect.acquireRelease(
                Effect.sync(() => runtime(directory, { advance: 30000 })),
                (worker) => Effect.promise(() => worker.dispose()),
              );
              const url = (yield* Effect.promise(() => worker.ready)).toString();
              const admin = yield* make({
                url,
                token: Redacted.make("cirro-local-test-credential"),
              });
              yield* admin.create({
                id: "active",
                policy: {
                  networkHosts: [],
                  interruptBudget: 100000,
                  memoryBytes: 8388608,
                  maxOutputBytes: 1048576,
                },
              });
              const grant = yield* admin.mintCapability("active", {
                permissions: ["read", "write", "execute"],
                expiresInSeconds: 3600,
              });
              const client = yield* make({ url, token: Redacted.make(grant.token) });
              if (mode === "termios") {
                yield* client.action("active", {
                  op: "filesystem.writeFile",
                  path: "/tmp/termios-child.wasm",
                  encoding: "base64",
                  content: Buffer.from(
                    yield* Effect.promise(() =>
                      Bun.file("dist/wasi-termios-child.wasm").arrayBuffer(),
                    ),
                  ).toString("base64"),
                });
                yield* client.action("active", {
                  op: "filesystem.chmod",
                  path: "/tmp/termios-child.wasm",
                  mode: 493,
                });
              }
              if (mode === "raw-owner") {
                yield* client.action("active", {
                  op: "filesystem.writeFile",
                  path: "/tmp/raw-recovery-child.wasm",
                  encoding: "base64",
                  content: Buffer.from(
                    yield* Effect.promise(() =>
                      Bun.file("dist/wasi-tty-raw-owner-recovery-child.wasm").arrayBuffer(),
                    ),
                  ).toString("base64"),
                });
                yield* client.action("active", {
                  op: "filesystem.chmod",
                  path: "/tmp/raw-recovery-child.wasm",
                  mode: 493,
                });
              }
              if (mode === "foreground") {
                for (const [name, artifact] of [
                  ["owned", "child"],
                  ["foreign", "foreign"],
                ] as const) {
                  yield* client.action("active", {
                    op: "filesystem.writeFile",
                    path: `/tmp/tty-${name}.wasm`,
                    encoding: "base64",
                    content: Buffer.from(
                      yield* Effect.promise(() =>
                        Bun.file(`dist/wasi-tty-foreground-${artifact}.wasm`).arrayBuffer(),
                      ),
                    ).toString("base64"),
                  });
                  yield* client.action("active", {
                    op: "filesystem.chmod",
                    path: `/tmp/tty-${name}.wasm`,
                    mode: 493,
                  });
                }
              }
              if (mode === "family") {
                yield* client.action("active", {
                  op: "filesystem.writeFile",
                  path: "/tmp/recovery-child.wasm",
                  encoding: "base64",
                  content: Buffer.from(
                    yield* Effect.promise(() => Bun.file("dist/wasi-stdin.wasm").arrayBuffer()),
                  ).toString("base64"),
                });
                yield* client.action("active", {
                  op: "filesystem.chmod",
                  path: "/tmp/recovery-child.wasm",
                  mode: 493,
                });
              }
              const artifact = Match.value(mode).pipe(
                Match.when("family", () => "wasi-recovery-family.wasm"),
                Match.when("raw-owner", () => "wasi-tty-raw-owner-recovery.wasm"),
                Match.when("termios", () => "wasi-termios-recovery.wasm"),
                Match.when("geometry", () => "wasi-pty-resize-recovery.wasm"),
                Match.when("geometry-restart", () => "wasi-pty-resize-restart.wasm"),
                Match.when("signals", () => "wasi-tty-signals-recovery.wasm"),
                Match.when("foreground", () => "wasi-tty-foreground-recovery.wasm"),
                Match.when("delayed", () => "wasi-pty-recovery-delayed.wasm"),
                Match.when("cancelled", () => "wasi-pty-recovery-cooked.wasm"),
                Match.orElse((mode) => `wasi-pty-recovery-${mode}.wasm`),
              );
              const initial = Match.value(mode).pipe(
                Match.when("raw", () => "raw"),
                Match.orElse(() => "hel"),
              );
              yield* client.action("active", {
                op: "process.spawn",
                stdinMode: "pty",
                execution: {
                  op: "process.run",
                  id: "job",
                  language: "wasm",
                  source: Buffer.from(
                    yield* Effect.promise(() => Bun.file(`dist/${artifact}`).arrayBuffer()),
                  ).toString("base64"),
                  stdin: { content: initial, encoding: "utf8" },
                },
              });
              const objects = yield* Effect.promise(() => worker.objects);
              const key = "processes/active/job.json";
              const original = yield* Effect.promise(() => objects.head(key));
              if (original === null) return yield* Effect.die("Missing PTY reservation");
              const event = {
                id: "pty-checkpoint",
                timestamp: new Date(yield* Clock.currentTimeMillis),
                attempts: 1,
                body: Schema.encodeSync(ProcessDelivery)({ key, eTag: original.etag }),
              };
              const control = yield* Effect.promise(() => worker.control);
              const delivered = yield* Effect.promise(() => control.deliver("executions", [event]));
              const object = yield* Effect.promise(() => objects.get(key));
              if (object === null) return yield* Effect.die("Missing checkpointed receipt");
              const paused = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(StoredRun))(
                yield* Effect.promise(() => object.text()),
              );
              expect(delivered.outcome).toBe("ok");
              expect(paused.status).toBe("queued");
              expect(paused.stdinMode).toBe("pty");
              expect(paused.checkpointCount).toBe(1);
              if (paused.checkpoint === null) return yield* Effect.die("PTY did not checkpoint");
              const envelopeObject = yield* Effect.promise(() =>
                objects.get(`sandboxes/active/execution-checkpoints/${paused.checkpoint}.json`),
              );
              if (envelopeObject === null)
                return yield* Effect.die("Missing PTY checkpoint envelope");
              const envelope = yield* Schema.decodeUnknownEffect(
                Schema.fromJsonString(ExecutionCheckpoint),
              )(yield* Effect.promise(() => envelopeObject.text()));
              expect(envelope.savedAt).toBe(worker.time);
              const heapObject = yield* Effect.promise(() =>
                objects.get(`sandboxes/active/checkpoints/${envelope.heap}.json`),
              );
              if (heapObject === null) return yield* Effect.die("Missing PTY heap snapshot");
              const heap = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(HeapSnapshot))(
                yield* Effect.promise(() => heapObject.text()),
              );
              const pids = Match.value(mode).pipe(
                Match.when("family", () => [1, 2]),
                Match.when("raw-owner", () => [1, 2]),
                Match.when("termios", () => [1, 2]),
                Match.when("foreground", () => [1, 2]),
                Match.orElse(() => [1]),
              );
              expect(heap.handles.map((handle) => handle.pid).sort()).toEqual(pids);
              const preview = yield* client.action("active", { op: "process.get", id: "job" });
              expect(preview.output).not.toBeNull();
              if (preview.output === null)
                return yield* Effect.die("PTY checkpoint has no acknowledged output");
              const prefix = preview.output.stdout;
              if (mode === "cooked") expect(prefix).toBe("hel");
              if (mode === "raw") expect(prefix.endsWith("buffered\n")).toBe(true);
              if (mode === "raw-owner") expect(["raw-ready\n", "helraw-ready\n"]).toContain(prefix);
              if (mode === "termios") expect(["raw-ready\n", "helraw-ready\n"]).toContain(prefix);
              if (mode === "family") {
                expect(prefix).toContain("hel");
                expect(prefix.split("ready\r\n").length).toBe(2);
              }
              if (mode === "cancelled") expect(prefix).toBe("hel");
              if (mode === "signals") expect(prefix).toBe("ready\r\nhel");
              if (mode === "foreground") {
                expect(prefix).toContain("hel");
                expect(prefix.split("owned\r\n").length).toBe(2);
                expect(prefix.split("child-ready\r\n").length).toBe(2);
              }
              if (mode === "delayed") {
                expect(prefix).toContain("delayed\r\n");
                expect(prefix).toContain("hel");
              }
              if (mode === "raw")
                expect(
                  yield* client.action("active", {
                    op: "process.terminal.resize",
                    id: "job",
                    cols: 132,
                    rows: 45,
                    revision: 0,
                  }),
                ).toEqual({ cols: 132, rows: 45, revision: 1 });
              if (mode === "geometry" || mode === "geometry-restart") {
                yield* client.action("active", {
                  op: "process.terminal.resize",
                  id: "job",
                  cols: 120,
                  rows: 40,
                  revision: 0,
                });
                yield* client.action("active", {
                  op: "process.terminal.resize",
                  id: "job",
                  cols: 80,
                  rows: 24,
                  revision: 1,
                });
                expect(prefix).toBe("hel");
              }
              const tail = Match.value(mode).pipe(
                Match.when("raw", () => Buffer.from([0, 3, 4, 13, 10, 127, 255])),
                Match.when("signals", () => Buffer.from("\x03kept\n")),
                Match.when("foreground", () => Buffer.from([3])),
                Match.orElse(() => Buffer.from("lo\r")),
              );
              expect(
                yield* client
                  .action("neighbor", {
                    op: "process.stdin.write",
                    id: "job",
                    offset: 3,
                    content: tail.toString("base64"),
                    encoding: "base64",
                  })
                  .pipe(Effect.flip),
              ).toMatchObject({ status: 401 });
              const total = yield* Effect.gen(function* () {
                if (mode === "geometry") return 3;
                if (mode === "geometry-restart") {
                  yield* client.action("active", {
                    op: "process.stdin.close",
                    id: "job",
                    offset: 3,
                  });
                  return 3;
                }
                if (mode === "cancelled") {
                  yield* client.action("active", { op: "process.cancel", id: "job" });
                  expect(
                    yield* client
                      .action("active", {
                        op: "process.stdin.write",
                        id: "job",
                        offset: 3,
                        content: "lo\r",
                        encoding: "utf8",
                      })
                      .pipe(Effect.flip),
                  ).toMatchObject({ status: 409 });
                  return 3;
                }
                const appended = yield* client.action("active", {
                  op: "process.stdin.write",
                  id: "job",
                  offset: 3,
                  content: tail.toString("base64"),
                  encoding: "base64",
                });
                expect(appended.offset).toBe(3 + tail.length);
                yield* client.action("active", {
                  op: "process.stdin.close",
                  id: "job",
                  offset: 3 + tail.length,
                });
                return 3 + tail.length;
              });
              return {
                token: grant.token,
                key,
                event,
                time: worker.time,
                prefix,
                total,
              };
            }),
          );
          const worker = yield* Effect.acquireRelease(
            Effect.sync(() => runtime(directory, { clockStart: retained.time, advance: 1000 })),
            (worker) => Effect.promise(() => worker.dispose()),
          );
          const url = (yield* Effect.promise(() => worker.ready)).toString();
          const client = yield* make({ url, token: Redacted.make(retained.token) });
          const objects = yield* Effect.promise(() => worker.objects);
          const current = yield* Effect.promise(() => objects.head(retained.key));
          if (current === null)
            return yield* Effect.die("Checkpointed receipt lost after Worker replacement");
          const control = yield* Effect.promise(() => worker.control);
          const resumed = {
            ...retained.event,
            id: "pty-resume",
            body: Schema.encodeSync(ProcessDelivery)({ key: retained.key, eTag: current.etag }),
          };
          const delivery = yield* Effect.promise(() => control.deliver("executions", [resumed]));
          expect(delivery.explicitAcks).toEqual([resumed.id]);
          const record = yield* client.action("active", { op: "process.get", id: "job" });
          if (mode === "geometry" || mode === "geometry-restart")
            expect(
              yield* client.action("active", { op: "process.terminal.status", id: "job" }),
            ).toEqual({ cols: 80, rows: 24, revision: 2 });
          if (mode === "raw")
            expect(
              yield* client.action("active", { op: "process.terminal.status", id: "job" }),
            ).toEqual({ cols: 132, rows: 45, revision: 1 });
          if (mode === "cancelled") {
            expect(record.status).toBe("cancelled");
            expect(record.output?.exitCode).toBeNull();
          } else {
            expect(record.status).toBe("exited");
            expect(record.output?.exitCode).toBe(0);
          }
          expect(record.output?.stderr).toBe("");
          const output = yield* client.action("active", {
            op: "process.output.read",
            id: "job",
            after: null,
            maxBytes: 65536,
            maxEvents: 128,
          });
          expect(output.availability).toBe("retained");
          expect(output.hasMore).toBe(false);
          const bytes = Buffer.concat(
            output.events.map((event) => Buffer.from(event.data, "base64")),
          );
          const suffix = Match.value(mode).pipe(
            Match.when("cancelled", () => Buffer.alloc(0)),
            Match.when("geometry", () => Buffer.from("winch\r\ndone\r\n")),
            Match.when("geometry-restart", () => Buffer.from("winch\r\ndone\r\n")),
            Match.when("signals", () => Buffer.from("kept\r\ninterrupt\r\ndone\r\n")),
            Match.when("foreground", () => Buffer.from("reclaimed\r\ndone\r\n")),
            Match.when("raw-owner", () => Buffer.from("restored\r\n")),
            Match.when("termios", () => Buffer.from("attrs-restored\ntranslated\r\n")),
            Match.when("cooked", () => Buffer.from("lo\r\nread:hello\r\neof\r\n")),
            Match.when("delayed", () => Buffer.from("lo\r\nread:hello\r\neof\r\n")),
            Match.when("family", () => Buffer.from("lo\r\nhello\r\n\r\nbytes=6\r\n")),
            Match.orElse(() =>
              Buffer.concat([
                Buffer.from("read:aw"),
                Buffer.from([0, 3, 4, 13, 10, 127, 255]),
                Buffer.from("eof\n"),
              ]),
            ),
          );
          expect(bytes).toEqual(Buffer.concat([Buffer.from(retained.prefix), suffix]));
          expect(
            yield* client.action("active", { op: "process.stdin.status", id: "job" }),
          ).toMatchObject({ offset: retained.total, total: retained.total, closed: true });
          const completed = yield* Effect.promise(() => objects.head(retained.key));
          if (completed === null) return yield* Effect.die("Completed PTY receipt missing");
          if (mode === "cancelled") expect(completed.etag).toBe(current.etag);
          const duplicate = { ...retained.event, id: "pty-stale-delivery", attempts: 2 };
          const repeated = yield* Effect.promise(() => control.deliver("executions", [duplicate]));
          expect(repeated.explicitAcks).toEqual([duplicate.id]);
          expect((yield* Effect.promise(() => objects.head(retained.key)))?.etag).toBe(
            completed.etag,
          );
          expect(
            yield* client.action("active", {
              op: "process.output.read",
              id: "job",
              after: null,
              maxBytes: 65536,
              maxEvents: 128,
            }),
          ).toEqual(output);
        }),
      ).pipe(
        Effect.provide(FetchHttpClient.layer),
        Effect.provideService(FetchHttpClient.RequestInit, { keepalive: false }),
      ),
    ));
}
