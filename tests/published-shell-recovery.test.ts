import { defaultSoftware } from "../src/default-software";
import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Clock, Effect, Redacted, Schema } from "effect";
import { FetchHttpClient } from "effect/http";
import { ProcessDelivery, StoredRun } from "../src/contracts";
import { make, makeBinding } from "../src/sdk";
import { runtime } from "../tooling/worker-test";
import { downloadSoftware } from "../tooling/software-artifacts";

test.each(["minimal", "reedline"] as const)(
  "published %s shell resumes a partial interactive command after Worker replacement without replaying writes",
  (backend) =>
    Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const directory = yield* Effect.acquireRelease(
            Effect.promise(() => mkdtemp(join(tmpdir(), "boxes-shell-recovery-"))),
            (path) => Effect.promise(() => rm(path, { recursive: true, force: true })),
          );
          const initial =
            "printf '\\nRUN\\n'; printf once >> /tmp/once\rprintf 'retained:%s\\n' kept";
          const terminal = { queries: 0 };
          const answerQueries = Effect.fn("test.shellRecovery.terminal")(function* (
            client: Effect.Success<ReturnType<typeof makeBinding>>,
          ) {
            const page = yield* client.action("shell", {
              op: "process.output.readLive",
              id: "interactive",
              after: null,
              maxBytes: 65536,
              maxEvents: 128,
            });
            const stdout = Buffer.concat(
              page.events.map((event) => Buffer.from(event.data, "base64")),
            ).toString();
            const queries = stdout.match(/\x1b\[6n/g)?.length ?? 0;
            if (queries > terminal.queries) {
              yield* Effect.gen(function* () {
                const input = yield* client.action("shell", {
                  op: "process.stdin.status",
                  id: "interactive",
                });
                yield* client.action("shell", {
                  op: "process.stdin.write",
                  id: "interactive",
                  offset: input.offset,
                  content: "\x1b[1;1R".repeat(queries - terminal.queries),
                  encoding: "utf8",
                });
                terminal.queries = queries;
              }).pipe(Effect.uninterruptible);
            }
            yield* Effect.sleep("10 millis");
          });
          const retained = yield* Effect.scoped(
            Effect.gen(function* () {
              const worker = yield* Effect.acquireRelease(
                Effect.sync(() =>
                  runtime(directory, { advance: 30000, advanceAfterOutput: "kept" }),
                ),
                (worker) => Effect.promise(() => worker.dispose()),
              );
              const admin = yield* make({
                url: (yield* Effect.promise(() => worker.ready)).toString(),
                token: Redacted.make("cirro-local-test-credential"),
              });
              yield* admin.create({
                id: "shell",
                policy: {
                  networkHosts: [],
                  interruptBudget: 100000,
                  memoryBytes: 8388608,
                  maxOutputBytes: 1048576,
                },
              });
              const grant = yield* admin.mintCapability("shell", {
                permissions: ["read", "write", "execute", "manage"],
                expiresInSeconds: 3600,
              });
              const client = yield* makeBinding(
                yield* Effect.promise(() => worker.service),
                Redacted.make(grant.token),
              );
              const software = defaultSoftware[0];
              const bytes = yield* downloadSoftware(software);
              yield* client.action("shell", {
                op: "filesystem.writeFile",
                path: "/tmp/sh.aospkg",
                content: Buffer.from(bytes).toString("base64"),
                encoding: "base64",
              });
              yield* client.action("shell", {
                op: "software.install",
                source: { path: "/tmp/sh.aospkg", digest: `sha256:${software.digest}` },
              });
              yield* client.action("shell", {
                op: "process.spawn",
                stdinMode: "pty",
                execution: {
                  op: "process.execFile",
                  id: "interactive",
                  command: "sh",
                  args: ["--input-backend", backend, "-i"],
                  env: { TERM: "xterm-256color", PS1: "BOXES$ " },
                  stdin: { content: initial, encoding: "utf8" },
                },
              });
              const key = "processes/shell/interactive.json";
              const objects = yield* Effect.promise(() => worker.objects);
              const head = yield* Effect.promise(() => objects.head(key));
              if (head === null) return yield* Effect.die("Missing shell reservation");
              const event = {
                id: "shell-checkpoint",
                timestamp: new Date(yield* Clock.currentTimeMillis),
                attempts: 1,
                body: Schema.encodeSync(ProcessDelivery)({ key, eTag: head.etag }),
              };
              const control = yield* Effect.promise(() => worker.control);
              const delivery = yield* Effect.raceFirst(
                Effect.promise(() => control.deliver("executions", [event])),
                answerQueries(client).pipe(Effect.forever),
              );
              expect(delivery.outcome).toBe("ok");
              const object = yield* Effect.promise(() => objects.get(key));
              if (object === null) return yield* Effect.die("Missing shell checkpoint receipt");
              const paused = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(StoredRun))(
                yield* Effect.promise(() => object.text()),
              );
              expect(paused.status).toBe("queued");
              expect(paused.checkpointCount).toBe(1);
              expect(paused.checkpoint).not.toBeNull();
              const prefix = yield* client.action("shell", {
                op: "process.get",
                id: "interactive",
              });
              expect(prefix.output?.stdout).toMatch(/\r?\nRUN\r?\n/);
              if (prefix.output === null)
                return yield* Effect.die("Missing acknowledged shell output");
              return {
                token: grant.token,
                key,
                event,
                time: worker.time,
                prefix: prefix.output.stdout,
              };
            }),
          );
          const worker = yield* Effect.acquireRelease(
            Effect.sync(() =>
              runtime(directory, {
                clockStart: retained.time,
                advance: 30000,
                advanceAfterOutput: "completed:kept",
              }),
            ),
            (worker) => Effect.promise(() => worker.dispose()),
          );
          yield* Effect.promise(() => worker.ready);
          const client = yield* makeBinding(
            yield* Effect.promise(() => worker.service),
            Redacted.make(retained.token),
          );
          const tail = "\rprintf 'completed:%s\\n' kept; exit 7\r";
          const previousInput = yield* client.action("shell", {
            op: "process.stdin.status",
            id: "interactive",
          });
          const input = yield* client.action("shell", {
            op: "process.stdin.write",
            id: "interactive",
            offset: previousInput.offset,
            content: tail,
            encoding: "utf8",
          });
          expect(input.offset).toBe(previousInput.offset + Buffer.byteLength(tail));
          const objects = yield* Effect.promise(() => worker.objects);
          const head = yield* Effect.promise(() => objects.head(retained.key));
          if (head === null) return yield* Effect.die("Lost shell checkpoint after replacement");
          const event = {
            ...retained.event,
            id: "shell-resume",
            body: Schema.encodeSync(ProcessDelivery)({ key: retained.key, eTag: head.etag }),
          };
          const control = yield* Effect.promise(() => worker.control);
          const delivery = yield* Effect.raceFirst(
            Effect.promise(() => control.deliver("executions", [event])),
            answerQueries(client).pipe(Effect.forever),
          );
          expect(delivery.explicitAcks).toEqual([event.id]);
          const record = yield* client.action("shell", { op: "process.get", id: "interactive" });
          expect(record.status).toBe("exited");
          expect(record.output?.exitCode).toBe(7);
          expect(record.output?.stdout.startsWith(retained.prefix)).toBe(true);
          expect(record.output?.stdout.match(/\r?\nRUN\r?\n/g)).toHaveLength(1);
          expect(record.output?.stdout).toContain("retained:kept");
          expect(record.output?.stdout).toContain("completed:kept");
          const file = yield* client.action("shell", {
            op: "filesystem.readFile",
            path: "/tmp/once",
          });
          expect(Buffer.from(file.content, file.encoding).toString()).toBe("once");
          const replay = yield* Effect.promise(() => control.deliver("executions", [event]));
          expect(replay.explicitAcks).toEqual([event.id]);
          expect(yield* client.action("shell", { op: "process.get", id: "interactive" })).toEqual(
            record,
          );
          expect(
            yield* client.action("shell", { op: "filesystem.readFile", path: "/tmp/once" }),
          ).toEqual(file);
        }),
      ).pipe(Effect.provide(FetchHttpClient.layer)),
    ),
  20000,
);
