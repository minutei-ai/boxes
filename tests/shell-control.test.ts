import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Redacted } from "effect";
import { FetchHttpClient } from "effect/http";
import { make } from "../src/sdk";
import { runtime } from "../tooling/worker-test";

test("conditional lists skip whole pipelines without executing redirected writes", () =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const directory = yield* Effect.acquireRelease(
          Effect.promise(() => mkdtemp(join(tmpdir(), "boxes-shell-control-"))),
          (path) => Effect.promise(() => rm(path, { recursive: true, force: true })),
        );
        const worker = yield* Effect.acquireRelease(
          Effect.sync(() => runtime(directory)),
          (worker) => Effect.promise(() => worker.dispose()),
        );
        const url = (yield* Effect.promise(() => worker.ready)).toString();
        const admin = yield* make({ url, token: Redacted.make("cirro-local-test-credential") });
        const id = "shell-control";
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
          permissions: ["read", "write", "execute"],
          expiresInSeconds: 600,
        });
        const client = yield* make({ url, token: Redacted.make(grant.token) });
        const cases = [
          "false && echo blocked | echo leaked",
          "true || echo blocked | echo leaked",
          "false && echo blocked | echo leaked | echo third; echo safe",
          "true || echo blocked | echo leaked && echo safe",
          "false && echo blocked | true || echo recovered",
          "false && echo blocked | true; echo next | cat",
          "true || echo blocked | false; echo next | cat",
          "false | true && echo success",
          "true | false || echo failure",
          "false &&\necho blocked | echo leaked\necho safe",
        ];
        yield* Effect.forEach(
          cases,
          (source, index) =>
            Effect.gen(function* () {
              const oracle = yield* Effect.sync(() =>
                Bun.spawn(["sh", "-c", source], { stdout: "pipe", stderr: "pipe" }),
              );
              const stdout = yield* Effect.promise(() => new Response(oracle.stdout).text());
              const stderr = yield* Effect.promise(() => new Response(oracle.stderr).text());
              const exitCode = yield* Effect.promise(() => oracle.exited);
              const result = yield* client.action(id, {
                op: "process.run",
                id: `case-${index}`,
                language: "shell",
                source,
              });
              expect(result.output, source).toMatchObject({ stdout, stderr, exitCode });
            }),
          { concurrency: 1 },
        );
        const redirected = yield* client.action(id, {
          op: "process.run",
          id: "redirected",
          language: "shell",
          source:
            "false && echo denied | cat > /tmp/denied; true || echo denied | cat > /tmp/also-denied; echo kept > /tmp/kept",
        });
        expect(redirected.output?.exitCode).toBe(0);
        for (const path of ["/tmp/denied", "/tmp/also-denied"]) {
          expect(yield* client.action(id, { op: "filesystem.exists", path })).toEqual({
            exists: false,
          });
        }
        const kept = yield* client.action(id, { op: "filesystem.readFile", path: "/tmp/kept" });
        expect(kept.content).toBe(Buffer.from("kept\n").toString("base64"));
      }),
    ).pipe(Effect.provide(FetchHttpClient.layer)),
  ));
