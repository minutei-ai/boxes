import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Redacted, Schema } from "effect";
import { FetchHttpClient } from "effect/http";
import { ProcessDelivery } from "../src/contracts";
import { make } from "../src/sdk";
import { runtime } from "../tooling/worker-test";
import { commandPackage } from "./fixtures/package";

test(
  "execFile resolves bounded executable interpreter chains and captures them before Queue handover",
  () =>
    Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const directory = yield* Effect.acquireRelease(
            Effect.promise(() => mkdtemp(join(tmpdir(), "boxes-interpreter-"))),
            (path) => Effect.promise(() => rm(path, { recursive: true, force: true })),
          );
          const first = yield* Effect.acquireRelease(
            Effect.sync(() => runtime(directory)),
            (worker) => Effect.promise(() => worker.dispose()),
          );
          const url = (yield* Effect.promise(() => first.ready)).toString();
          const admin = yield* make({ url, token: Redacted.make("cirro-local-test-credential") });
          const id = "interpreters";
          yield* admin.create({
            id,
            policy: {
              networkHosts: [],
              interruptBudget: 1000,
              memoryBytes: 8388608,
              maxOutputBytes: 1048576,
            },
          });
          const grant = yield* admin.mintCapability(id, {
            permissions: ["read", "write", "execute", "manage"],
            expiresInSeconds: 600,
          });
          const client = yield* make({ url, token: Redacted.make(grant.token) });
          const binary = Buffer.from(
            yield* Effect.promise(() => Bun.file("dist/wasi-inputs.wasm").arrayBuffer()),
          );
          yield* client.action(id, {
            op: "filesystem.writeFile",
            path: "/tmp/package",
            content: commandPackage(binary).toString("base64"),
            encoding: "base64",
          });
          yield* client.action(id, { op: "software.install", source: { path: "/tmp/package" } });
          const interpreter = "/opt/cirro/pkgs/probe/1.0.0/bin/probe";
          const scripts = [
            { path: "/tmp/script", source: `#! ${interpreter}\t one two  \nignored body` },
            { path: "/tmp/outer", source: "#!/tmp/script outer option\n" },
            { path: "/tmp/third", source: "#!/tmp/outer\n" },
            { path: "/tmp/fourth", source: "#!/tmp/third\n" },
            { path: "/tmp/loop", source: "#!/tmp/loop\n" },
            { path: "/tmp/missing", source: "#!/tmp/not-installed\n" },
            { path: "/tmp/empty", source: "#! \t\n" },
            { path: "/tmp/relative", source: `#!../../${interpreter.slice(1)}\n` },
          ];
          yield* Effect.forEach(scripts, (script) =>
            Effect.gen(function* () {
              yield* client.action(id, {
                op: "filesystem.writeFile",
                path: script.path,
                content: script.source,
                encoding: "utf8",
              });
              yield* client.action(id, { op: "filesystem.chmod", path: script.path, mode: 493 });
            }),
          );
          const direct = yield* client.action(id, {
            op: "process.execFile",
            id: "direct",
            command: "/tmp/outer",
            args: ["tail", "a b"],
            env: { CIRRO_MARKER: "caller" },
            stdin: { content: "AP+A", encoding: "base64" },
          });
          expect(direct.status).toBe("exited");
          expect(direct.output?.exitCode).toBe(0);
          expect(direct.output?.stdout).toContain(
            `argv=["${interpreter}", "one two", "/tmp/script", "outer option", "/tmp/outer", "tail", "a b"]`,
          );
          expect(direct.output?.stdout).toContain("marker=caller");
          expect(direct.output?.stdout).toContain("stdin=[0, 255, 128]");
          const fourth = yield* client.action(id, {
            op: "process.execFile",
            id: "fourth",
            command: "/tmp/fourth",
          });
          expect(fourth.output?.exitCode).toBe(0);
          expect(fourth.output?.stdout).toContain(
            `argv=["${interpreter}", "one two", "/tmp/script", "outer option", "/tmp/outer", "/tmp/third", "/tmp/fourth"]`,
          );
          const relative = yield* client.action(id, {
            op: "process.execFile",
            id: "relative",
            command: "/tmp/relative",
          });
          expect(relative.output?.stdout).toContain(`argv=["${interpreter}", "/tmp/relative"]`);
          const shell = yield* client.action(id, {
            op: "process.run",
            id: "shell",
            language: "shell",
            source: "echo input | /tmp/script tail",
          });
          expect(shell.output?.stdout).toContain(
            `argv=["${interpreter}", "one two", "/tmp/script", "tail"]`,
          );
          expect(shell.output?.stdout).toContain("stdin=[105, 110, 112, 117, 116, 10]");
          for (const item of [
            { name: "loop", error: "ELOOP" },
            { name: "missing", error: "ENOENT" },
            { name: "empty", error: "ENOEXEC" },
          ]) {
            const failure = yield* client
              .action(id, { op: "process.execFile", id: item.name, command: `/tmp/${item.name}` })
              .pipe(Effect.flip);
            expect(failure).toMatchObject({ _tag: "BoxesError", error: item.error });
          }
          const oversized = yield* client
            .action(id, {
              op: "process.execFile",
              id: "oversized",
              command: "/tmp/script",
              args: Array.from({ length: 128 }, () => "a"),
            })
            .pipe(Effect.flip);
          expect(oversized).toMatchObject({ _tag: "BoxesError", error: "E2BIG" });
          yield* client.action(id, { op: "filesystem.chmod", path: "/tmp/script", mode: 420 });
          const denied = yield* client
            .action(id, { op: "process.execFile", id: "denied", command: "/tmp/outer" })
            .pipe(Effect.flip);
          expect(denied).toMatchObject({ _tag: "BoxesError", error: "EACCES" });
          yield* client.action(id, { op: "filesystem.chmod", path: "/tmp/script", mode: 493 });
          const executeGrant = yield* admin.mintCapability(id, {
            permissions: ["execute"],
            expiresInSeconds: 600,
          });
          const executeOnly = yield* make({ url, token: Redacted.make(executeGrant.token) });
          const unreadable = yield* executeOnly
            .action(id, { op: "process.execFile", id: "unreadable", command: "/tmp/script" })
            .pipe(Effect.flip);
          expect(unreadable).toMatchObject({ _tag: "BoxesError", status: 403 });
          yield* admin.create({
            id: "isolated-interpreters",
            policy: {
              networkHosts: [],
              interruptBudget: 1000,
              memoryBytes: 8388608,
              maxOutputBytes: 1048576,
            },
          });
          const isolated = yield* admin.mintCapability("isolated-interpreters", {
            permissions: ["read", "execute"],
            expiresInSeconds: 600,
          });
          const outsider = yield* make({ url, token: Redacted.make(isolated.token) });
          expect(
            yield* outsider
              .action(id, { op: "process.execFile", id: "cross-tenant", command: "/tmp/script" })
              .pipe(Effect.flip),
          ).toMatchObject({ _tag: "BoxesError", status: 401 });
          yield* client.action(id, {
            op: "process.spawn",
            execution: {
              op: "process.execFile",
              id: "queued",
              command: "/tmp/script",
              args: ["captured"],
              env: { CIRRO_MARKER: "admitted" },
              stdin: { content: "saved", encoding: "utf8" },
            },
          });
          yield* client.action(id, {
            op: "filesystem.writeFile",
            path: "/tmp/script",
            content: "#!/tmp/missing\n",
            encoding: "utf8",
          });
          yield* Effect.promise(() => first.dispose());
          const next = yield* Effect.acquireRelease(
            Effect.sync(() => runtime(directory)),
            (worker) => Effect.promise(() => worker.dispose()),
          );
          const nextClient = yield* make({
            url: (yield* Effect.promise(() => next.ready)).toString(),
            token: Redacted.make(grant.token),
          });
          const objects = yield* Effect.promise(() => next.objects);
          const key = `processes/${id}/queued.json`;
          const receipt = yield* Effect.promise(() => objects.head(key));
          if (receipt === null) return yield* Effect.die("Missing queued interpreter receipt");
          const control = yield* Effect.promise(() => next.control);
          yield* Effect.promise(() =>
            control.deliver("executions", [
              {
                id: "interpreter",
                timestamp: new Date(),
                attempts: 1,
                body: Schema.encodeSync(ProcessDelivery)({ key, eTag: receipt.etag }),
              },
            ]),
          );
          const queued = yield* nextClient.action(id, { op: "process.get", id: "queued" });
          expect(queued.status).toBe("exited");
          expect(queued.output?.stdout).toContain(
            `argv=["${interpreter}", "one two", "/tmp/script", "captured"]`,
          );
          expect(queued.output?.stdout).toContain("marker=admitted");
          expect(queued.output?.stdout).toContain("stdin=[115, 97, 118, 101, 100]");
          yield* nextClient.action(id, { op: "vm.dispose" });
        }),
      ).pipe(
        Effect.provide(FetchHttpClient.layer),
        Effect.provideService(FetchHttpClient.RequestInit, { keepalive: false }),
      ),
    ),
  15000,
);
