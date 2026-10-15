import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Redacted } from "effect";
import { FetchHttpClient } from "effect/http";
import { make } from "../src/sdk";
import { runtime } from "../tooling/worker-test";

test("native readonly shell attributes reject mutations without leaking across pipelines or runs", () =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const directory = yield* Effect.acquireRelease(
          Effect.promise(() => mkdtemp(join(tmpdir(), "boxes-shell-readonly-"))),
          (path) => Effect.promise(() => rm(path, { recursive: true, force: true })),
        );
        const worker = yield* Effect.acquireRelease(
          Effect.sync(() => runtime(directory)),
          (worker) => Effect.promise(() => worker.dispose()),
        );
        const url = (yield* Effect.promise(() => worker.ready)).toString();
        const admin = yield* make({ url, token: Redacted.make("cirro-local-test-credential") });
        const environment = { VALUE: " two words " };
        yield* admin.create({
          id: "readonly",
          environment,
          policy: {
            networkHosts: [],
            interruptBudget: 1000,
            memoryBytes: 8388608,
            maxOutputBytes: 1048576,
          },
        });
        const grant = yield* admin.mintCapability("readonly", {
          permissions: ["read", "write", "execute"],
          expiresInSeconds: 600,
        });
        const client = yield* make({ url, token: Redacted.make(grant.token) });
        const cases = [
          'readonly A=one; echo "$A"',
          'A=one; readonly A; echo "$A"',
          'readonly A; echo "[$A]"',
          "readonly A; unset A; echo after",
          'readonly A; export A; echo "[$A]"',
          'readonly A=""; A=two; echo after',
          "readonly A=one; A=two; echo after",
          "readonly A=one; A=one; echo after",
          "readonly A=one; A=two echo command; echo after",
          'readonly A=one; export A=two; echo "after:$A:$?"',
          'readonly A=one; readonly A=two; echo "after:$A:$?"',
          'readonly A=one; unset A; echo "after:$A:$?"',
          'readonly A=one; export A; echo "$A:$?"',
          'readonly A=one; readonly A; echo "$A:$?"',
          'readonly A=one | cat; A=two; echo "$A"',
          'readonly A=one; A=two | cat; echo "$A:$?"',
          'readonly A=one; unset A | cat; echo "$A:$?"',
          'readonly A=one; export A=two | cat; echo "$A:$?"',
          'readonly A=$VALUE; echo "[$A]"',
          'CMD=readonly; $CMD A=$VALUE; echo "[$A]"',
          '"readonly" A=$VALUE; echo "[$A]"',
          'readonly -- A=one; echo "$A"',
          'readonly -p -- A=one; echo "$A:$?"',
          "readonly bad-name; echo after",
          'readonly A=one; false && A=two; echo "$A:$?"',
          "readonly A=one; ! A=two; echo after",
          "readonly HOME=/tmp; cd; pwd",
        ];
        yield* Effect.forEach(cases, (source, index) =>
          Effect.gen(function* () {
            const oracle = Bun.spawn(["sh", "-c", source], {
              env: { PATH: "/usr/bin:/bin", ...environment },
              stdout: "pipe",
              stderr: "pipe",
            });
            const [stdout, stderr, exitCode] = yield* Effect.promise(() =>
              Promise.all([
                new Response(oracle.stdout).text(),
                new Response(oracle.stderr).text(),
                oracle.exited,
              ]),
            );
            const result = yield* client.action("readonly", {
              op: "process.run",
              id: `oracle-${index}`,
              language: "shell",
              source,
            });
            expect(result.output?.stdout).toBe(stdout);
            expect(result.output?.exitCode === 0).toBe(exitCode === 0);
            expect(result.output?.stderr.length === 0).toBe(stderr.length === 0);
            if (exitCode !== 0) expect(result.output?.exitCode).toBe(2);
          }),
        );
        const openFailure = yield* client.action("readonly", {
          op: "process.run",
          id: "before-open",
          language: "shell",
          source: "readonly A=one; A=two > /tmp/forbidden; echo after",
        });
        expect(openFailure.output?.exitCode).toBe(2);
        expect(openFailure.output?.stdout).toBe("");
        const absent = yield* client
          .action("readonly", { op: "filesystem.stat", path: "/tmp/forbidden", follow: true })
          .pipe(Effect.flip);
        expect(absent).toMatchObject({ status: 404, error: "ENOENT" });
        const listing = yield* client.action("readonly", {
          op: "process.run",
          id: "listing",
          language: "shell",
          source: 'readonly A="a\'b"; readonly UNSET; readonly -p',
        });
        expect(listing.output?.stdout).toBe("readonly A='a'\\''b'\nreadonly UNSET\n");
        const replay = Bun.spawn(
          ["sh", "-c", `${listing.output?.stdout}echo "$A"; A=changed; echo after`],
          { env: { PATH: "/usr/bin:/bin" }, stdout: "pipe", stderr: "pipe" },
        );
        const [replayed, rejected, replayStatus] = yield* Effect.promise(() =>
          Promise.all([
            new Response(replay.stdout).text(),
            new Response(replay.stderr).text(),
            replay.exited,
          ]),
        );
        expect(replayed).toBe("a'b\n");
        expect(rejected).toContain("readonly");
        expect(replayStatus).not.toBe(0);
        const quota = yield* client.action("readonly", {
          op: "process.run",
          id: "quota",
          language: "shell",
          source: `readonly ${Array.from({ length: 129 }, (_, index) => `V${index}`).join(" ")}; echo after`,
        });
        expect(quota.output?.exitCode).toBe(2);
        expect(quota.output?.stderr).toContain("quota");
        expect(quota.output?.stdout).toBe("");
        const fresh = yield* client.action("readonly", {
          op: "process.run",
          id: "fresh",
          language: "shell",
          source: 'A=new; echo "$A"',
        });
        expect(fresh.output?.stdout).toBe("new\n");
        expect(fresh.output?.exitCode).toBe(0);
        expect((yield* client.action("readonly", { op: "config.get" })).environment).toEqual(
          environment,
        );
      }),
    ).pipe(Effect.provide(FetchHttpClient.layer)),
  ));
