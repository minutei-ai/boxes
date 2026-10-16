import { downloadPublished } from "./fixtures/published-package";
import { afterAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { Effect, Redacted, Schema } from "effect";
import { FetchHttpClient } from "effect/http";
import { make } from "../src/sdk";
import { runtime } from "../tooling/worker-test";
import { ProcessDelivery, StoredRun } from "../src/contracts";
import {
  publishedPackages,
  publishedShellCases,
  publishedInterpreterFile,
  publishedInterpreterCases,
} from "./fixtures/published-software";

const directory = await mkdtemp("/tmp/boxes-published-shell-test-");
const worker = runtime(directory, { controlled: false });
afterAll(async () => {
  await worker.dispose();
  await rm(directory, { recursive: true, force: true });
});

test(
  "published sh and jq compose through native pipes, files and process-local creation masks",
  () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const url = (yield* Effect.promise(() => worker.ready)).toString();
        const admin = yield* make({ url, token: Redacted.make("cirro-local-test-credential") });
        const id = "published";
        yield* admin.create({
          id,
          policy: {
            networkHosts: [],
            interruptBudget: 100000,
            memoryBytes: 8388608,
            maxOutputBytes: 1048576,
          },
        });
        const grant = yield* admin.mintCapability(id, {
          permissions: ["read", "write", "execute", "manage"],
          expiresInSeconds: 600,
        });
        const client = yield* make({ url, token: Redacted.make(grant.token) });
        yield* Effect.forEach(publishedPackages, (software) =>
          Effect.gen(function* () {
            const bytes = yield* downloadPublished(software);
            const path = `/tmp/${software.name}.aospkg`;
            yield* client.action(id, {
              op: "filesystem.writeFile",
              path,
              content: Buffer.from(bytes).toString("base64"),
              encoding: "base64",
            });
            yield* client.action(id, {
              op: "software.install",
              source: { path, digest: `sha256:${software.digest}` },
            });
          }),
        );

        yield* client.action(id, { op: "filesystem.writeFile", ...publishedInterpreterFile });
        yield* client.action(id, {
          op: "filesystem.chmod",
          path: publishedInterpreterFile.path,
          mode: 493,
        });
        for (const probe of publishedInterpreterCases) {
          const run = yield* client.action(id, {
            op: "process.execFile",
            id: probe.id,
            command: probe.command,
            args: probe.args,
            env: { CIRRO_MARKER: probe.id },
            stdin: { content: "input line\n", encoding: "utf8" },
          });
          expect(run.status).toBe("exited");
          expect(run.output?.exitCode).toBe(0);
          expect(run.output?.stderr).toBe("");
          expect(run.output?.stdout).toBe(probe.stdout);
          const scriptFile = yield* client.action(id, {
            op: "filesystem.readFile",
            path: "/tmp/from-script",
          });
          expect(Buffer.from(scriptFile.content, scriptFile.encoding).toString("utf8")).toBe(
            probe.id,
          );
        }
        yield* client.action(id, {
          op: "filesystem.writeFile",
          path: "/tmp/data",
          content: "ABC",
          encoding: "utf8",
        });
        for (const mode of [
          "fexec",
          "fexec-unlink",
          "fexec-rename",
          "fexec-cloexec",
          "fexec-closed",
        ]) {
          yield* client.action(id, {
            op: "filesystem.writeFile",
            path: "/tmp/next.wasm",
            content:
              '#!/opt/cirro/bin/sh\nprintf "%s|%s|%s\\n" "$0" "$1" "$COLOR"; printf descriptor > /tmp/from-descriptor',
            encoding: "utf8",
          });
          yield* client.action(id, { op: "filesystem.chmod", path: "/tmp/next.wasm", mode: 493 });
          const source = Buffer.from(
            yield* Effect.promise(() => Bun.file(`dist/wasi-exec-${mode}.wasm`).arrayBuffer()),
          ).toString("base64");
          const result = yield* client.action(id, {
            op: "process.run",
            id: `script-${mode}`,
            language: "wasm",
            source,
          });
          expect(result.status).toBe("exited");
          expect(result.output?.exitCode).toBe(0);
          expect(result.output?.stderr).toBe("");
          if (mode === "fexec-cloexec" || mode === "fexec-closed") {
            expect(result.output?.result).toBe(44);
            expect(result.output?.stdout).toBe("");
          } else {
            expect(result.output?.stdout).toBe("/dev/fd/12|fexec|blue\n");
            const persisted = yield* client.action(id, {
              op: "filesystem.readFile",
              path: "/tmp/from-descriptor",
            });
            expect(Buffer.from(persisted.content, persisted.encoding).toString("utf8")).toBe(
              "descriptor",
            );
          }
        }
        yield* client.action(id, {
          op: "filesystem.mkdir",
          path: "/tmp/context",
          recursive: false,
        });
        yield* client.action(id, {
          op: "filesystem.symlink",
          path: "/tmp/context/interpreter",
          target: "/opt/cirro/bin/sh",
        });
        yield* client.action(id, {
          op: "filesystem.writeFile",
          path: "/tmp/context/script",
          content: '#!./interpreter\nprintf "%s|%s|%s\\n" "$PWD" "$0" "$1"',
          encoding: "utf8",
        });
        yield* client.action(id, {
          op: "filesystem.chmod",
          path: "/tmp/context/script",
          mode: 493,
        });
        const relativeInterpreter = yield* client.action(id, {
          op: "process.execFile",
          id: "relative-interpreter",
          command: "sh",
          args: ["-c", "cd /tmp/context; /opt/cirro/bin/sh -c 'exec ./script hello'"],
        });
        expect(relativeInterpreter.output).toMatchObject({
          exitCode: 0,
          stderr: "",
          stdout: "/tmp/context|/tmp/context/script|hello\n",
        });

        yield* Effect.forEach(publishedShellCases, (probe, index) =>
          Effect.gen(function* () {
            const run = yield* client.action(id, {
              op: "process.execFile",
              id: `case-${index}`,
              command: "sh",
              args: ["-c", probe.source],
              env: { PATH: "/opt/cirro/bin" },
            });
            expect(run.status).toBe("exited");
            expect(run.output?.exitCode).toBe(0);
            expect(run.output?.stderr).toBe("");
            expect(run.output?.stdout).toBe(probe.stdout);
          }),
        );
        expect(
          (yield* client.action(id, { op: "filesystem.stat", path: "/tmp/private", follow: true }))
            .mode & 0o777,
        ).toBe(0o600);
        const readerGrant = yield* admin.mintCapability(id, {
          permissions: ["read", "execute"],
          expiresInSeconds: 600,
        });
        const reader = yield* make({ url, token: Redacted.make(readerGrant.token) });
        const localMask = yield* reader.action(id, {
          op: "process.execFile",
          id: "readonly-mask",
          command: "sh",
          args: ["-c", "umask 077; umask"],
        });
        expect(localMask.output?.exitCode).toBe(0);
        expect(localMask.output?.stdout).toBe("0077\n");
        const denied = yield* reader.action(id, {
          op: "process.execFile",
          id: "denied-create",
          command: "sh",
          args: ["-c", "umask 077; echo denied > /tmp/denied"],
        });
        expect(denied.status).toBe("exited");
        expect(denied.output?.exitCode).toBe(1);
        expect(
          (yield* client.action(id, { op: "filesystem.exists", path: "/tmp/denied" })).exists,
        ).toBe(false);
        const fixture = Buffer.from(
          yield* Effect.promise(() => Bun.file("dist/wasi-umask.wasm").arrayBuffer()),
        ).toString("base64");
        const mask = yield* client.action(id, {
          op: "process.run",
          id: "abi-mask",
          language: "wasm",
          source: fixture,
        });
        expect(mask.output?.exitCode).toBe(0);
        expect(mask.output?.stdout).toBe("umask bounds and creation modes verified\n");
        const terminal = yield* client.action(id, {
          op: "process.run",
          id: "tty",
          language: "wasm",
          source: fixture,
          args: ["--tty-read"],
        });
        expect(terminal.status).toBe("failed");
        expect(terminal.output?.exitCode).toBeNull();
        expect(terminal.output?.stdout).toBe("before terminal input\n");
        yield* client.action(id, { op: "vm.dispose" });
      }).pipe(Effect.provide(FetchHttpClient.layer)),
    ),
  30000,
);

test(
  "umask survives queued heap handover and replacement Worker",
  () =>
    Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const directory = yield* Effect.acquireRelease(
            Effect.promise(() => mkdtemp("/tmp/boxes-mask-recovery-")),
            (path) => Effect.promise(() => rm(path, { recursive: true, force: true })),
          );
          const id = "mask-recovery";
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
                id,
                policy: {
                  networkHosts: [],
                  interruptBudget: 100000,
                  memoryBytes: 8388608,
                  maxOutputBytes: 1048576,
                },
              });
              const grant = yield* admin.mintCapability(id, {
                permissions: ["read", "write", "execute", "manage"],
                expiresInSeconds: 600,
              });
              const client = yield* make({ url, token: Redacted.make(grant.token) });
              const source = Buffer.from(
                yield* Effect.promise(() => Bun.file("dist/wasi-umask.wasm").arrayBuffer()),
              ).toString("base64");
              yield* client.action(id, {
                op: "process.spawn",
                execution: {
                  op: "process.run",
                  id: "waiting",
                  language: "wasm",
                  source,
                  args: ["--checkpoint"],
                },
              });
              const objects = yield* Effect.promise(() => worker.objects);
              const key = `processes/${id}/waiting.json`;
              const receipt = yield* Effect.promise(() => objects.head(key));
              if (receipt === null) return yield* Effect.die("Missing mask reservation");
              const control = yield* Effect.promise(() => worker.control);
              yield* Effect.promise(() =>
                control.deliver("executions", [
                  {
                    id: "park",
                    timestamp: new Date(),
                    attempts: 1,
                    body: Schema.encodeSync(ProcessDelivery)({ key, eTag: receipt.etag }),
                  },
                ]),
              );
              const body = yield* Effect.promise(() => objects.get(key));
              if (body === null) return yield* Effect.die("Missing mask checkpoint");
              const parked = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(StoredRun))(
                yield* Effect.promise(() => body.text()),
              );
              expect(parked.status).toBe("queued");
              expect(parked.checkpoint).not.toBeNull();
              expect(parked.checkpointCount).toBe(1);
              return { grant, key, time: worker.time };
            }),
          );
          const next = yield* Effect.acquireRelease(
            Effect.sync(() => runtime(directory, { clockStart: retained.time, advance: 1000 })),
            (worker) => Effect.promise(() => worker.dispose()),
          );
          const objects = yield* Effect.promise(() => next.objects);
          const saved = yield* Effect.promise(() => objects.head(retained.key));
          if (saved === null) return yield* Effect.die("Missing retained mask state");
          const control = yield* Effect.promise(() => next.control);
          yield* Effect.promise(() =>
            control.deliver("executions", [
              {
                id: "resume",
                timestamp: new Date(),
                attempts: 1,
                body: Schema.encodeSync(ProcessDelivery)({ key: retained.key, eTag: saved.etag }),
              },
            ]),
          );
          const client = yield* make({
            url: (yield* Effect.promise(() => next.ready)).toString(),
            token: Redacted.make(retained.grant.token),
          });
          const result = yield* client.action(id, { op: "process.get", id: "waiting" });
          expect(result.status).toBe("exited");
          expect(result.output?.exitCode).toBe(0);
          expect(result.output?.stdout).toBe(
            "mask checkpoint ready\numask bounds and creation modes verified\n",
          );
          expect(
            (yield* client.action(id, {
              op: "filesystem.stat",
              path: "/tmp/masked-directory",
              follow: true,
            })).mode & 0o777,
          ).toBe(0o700);
          yield* client.action(id, { op: "vm.dispose" });
        }),
      ).pipe(Effect.provide(FetchHttpClient.layer)),
    ),
  20000,
);
