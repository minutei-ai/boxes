import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Redacted, Schema } from "effect";
import { FetchHttpClient } from "effect/http";
import { make } from "../src/sdk";
import { ProcessDelivery } from "../src/contracts";
import { runtime } from "../tooling/worker-test";

test(
  "native shell expands captured parameters with quote boundaries, pipeline status and ordered redirects",
  () =>
    Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const directory = yield* Effect.acquireRelease(
            Effect.promise(() => mkdtemp(join(tmpdir(), "boxes-shell-parameters-"))),
            (path) => Effect.promise(() => rm(path, { recursive: true, force: true })),
          );
          const first = yield* Effect.acquireRelease(
            Effect.sync(() => runtime(directory)),
            (worker) => Effect.promise(() => worker.dispose()),
          );
          const url = (yield* Effect.promise(() => first.ready)).toString();
          const admin = yield* make({ url, token: Redacted.make("cirro-local-test-credential") });
          const id = "parameters";
          const variables = { VALUE: " a  b ", EMPTY: "", TARGET: "/tmp/with space" };
          yield* admin.create({
            id,
            policy: {
              networkHosts: [],
              interruptBudget: 1000,
              memoryBytes: 8388608,
              maxOutputBytes: 1048576,
            },
            environment: variables,
          });
          const grant = yield* admin.mintCapability(id, {
            permissions: ["read", "write", "execute", "manage"],
            expiresInSeconds: 600,
          });
          const client = yield* make({ url, token: Redacted.make(grant.token) });
          const cases = [
            'echo "$VALUE"',
            "echo '$VALUE'",
            String.raw`echo \$VALUE`,
            "echo pre${VALUE}post",
            'echo before "$EMPTY" after',
            "echo $MISSING tail",
            "$MISSING echo shifted",
            'echo ""$VALUE',
            'echo $VALUE""',
            'echo "a"$VALUE"b"',
            "false; echo $?",
            'false; true | echo "$?"',
            'true; false | echo "$?"',
            "! true; echo $?",
            'false && echo "$VALUE" | cat; echo $?',
            'true || echo "$VALUE" | cat; echo $?',
            'echo "$VALUE" | cat',
          ];
          yield* Effect.forEach(cases, (source, index) =>
            Effect.gen(function* () {
              const oracle = yield* Effect.sync(() =>
                Bun.spawn(["sh", "-c", source], {
                  env: { PATH: "/usr/bin:/bin", ...variables },
                  stdout: "pipe",
                  stderr: "pipe",
                }),
              );
              const [stdout, stderr, exitCode] = yield* Effect.promise(() =>
                Promise.all([
                  new Response(oracle.stdout).text(),
                  new Response(oracle.stderr).text(),
                  oracle.exited,
                ]),
              );
              const run = yield* client.action(id, {
                op: "process.run",
                id: `case-${index}`,
                language: "shell",
                source,
              });
              expect({
                stdout: run.output?.stdout,
                stderr: run.output?.stderr,
                exitCode: run.output?.exitCode,
              }).toEqual({ stdout, stderr, exitCode });
            }),
          );
          const emptyCommand = yield* client.action(id, {
            op: "process.run",
            id: "empty-command",
            language: "shell",
            source: '""',
          });
          expect(emptyCommand.output?.exitCode).toBe(127);
          const skippedQuota = yield* client.action(id, {
            op: "process.run",
            id: "skipped-quota",
            language: "shell",
            source: `false && echo ${"$BIG".repeat(257)} > /tmp/skipped; echo safe`,
            env: { BIG: "v".repeat(4096) },
          });
          expect(skippedQuota.output?.stdout).toBe("safe\n");
          expect(
            (yield* client.action(id, { op: "filesystem.exists", path: "/tmp/skipped" })).exists,
          ).toBe(false);
          const quoted = yield* client.action(id, {
            op: "process.run",
            id: "quoted-target",
            language: "shell",
            source: 'echo stored > "$TARGET"; cat "$TARGET"',
          });
          expect(quoted.output?.stdout).toBe("stored\n");
          const ambiguous = yield* client.action(id, {
            op: "process.run",
            id: "ambiguous",
            language: "shell",
            source: "echo blocked > /tmp/earlier > $TARGET",
          });
          expect(ambiguous.output?.exitCode).toBe(1);
          expect(ambiguous.output?.stderr).toContain("Ambiguous shell redirection");
          expect(
            (yield* client.action(id, {
              op: "filesystem.stat",
              path: "/tmp/earlier",
              follow: true,
            })).size,
          ).toBe(0);
          const redirected = yield* client.action(id, {
            op: "process.run",
            id: "redirected-failure",
            language: "shell",
            source: "echo blocked 2> /tmp/errors > $TARGET; cat /tmp/errors",
          });
          expect(redirected.output?.stderr).toBe("");
          expect(redirected.output?.stdout).toContain("Ambiguous shell redirection");
          const injection = yield* client.action(id, {
            op: "process.run",
            id: "injection",
            language: "shell",
            source: 'echo "$VALUE"',
            env: { VALUE: "; touch /tmp/injected; echo unsafe" },
          });
          expect(injection.output?.stdout).toBe("; touch /tmp/injected; echo unsafe\n");
          expect(
            (yield* client.action(id, { op: "filesystem.exists", path: "/tmp/injected" })).exists,
          ).toBe(false);
          const quota = yield* client.action(id, {
            op: "process.run",
            id: "expansion-quota",
            language: "shell",
            source: `echo ${"$BIG".repeat(257)} > /tmp/never-opened`,
            env: { BIG: "v".repeat(4096) },
          });
          expect(quota.output?.exitCode).toBe(1);
          expect(
            (yield* client.action(id, { op: "filesystem.exists", path: "/tmp/never-opened" }))
              .exists,
          ).toBe(false);
          const readGrant = yield* admin.mintCapability(id, {
            permissions: ["read", "execute"],
            expiresInSeconds: 600,
          });
          const reader = yield* make({ url, token: Redacted.make(readGrant.token) });
          const denied = yield* reader.action(id, {
            op: "process.run",
            id: "denied",
            language: "shell",
            source: 'echo denied > "$TARGET"',
            env: { TARGET: "/tmp/denied" },
          });
          expect(denied.output?.exitCode).toBe(1);
          expect(
            (yield* client.action(id, { op: "filesystem.exists", path: "/tmp/denied" })).exists,
          ).toBe(false);
          yield* client.action(id, {
            op: "process.spawn",
            execution: {
              op: "process.run",
              id: "queued",
              language: "shell",
              source: 'echo "$VALUE"',
            },
          });
          yield* client.action(id, {
            op: "config.patch",
            policy: {},
            environment: { VALUE: "next" },
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
          if (receipt === null) return yield* Effect.die("Missing queued shell snapshot");
          const control = yield* Effect.promise(() => next.control);
          yield* Effect.promise(() =>
            control.deliver("executions", [
              {
                id: "parameters",
                timestamp: new Date(),
                attempts: 1,
                body: Schema.encodeSync(ProcessDelivery)({ key, eTag: receipt.etag }),
              },
            ]),
          );
          expect(
            (yield* nextClient.action(id, { op: "process.get", id: "queued" })).output?.stdout,
          ).toBe(" a  b \n");
          const latest = yield* nextClient.action(id, {
            op: "process.run",
            id: "latest",
            language: "shell",
            source: 'echo "$VALUE"',
          });
          expect(latest.output?.stdout).toBe("next\n");
        }),
      ).pipe(Effect.provide(FetchHttpClient.layer)),
    ),
  20000,
);
