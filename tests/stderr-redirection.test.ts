import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Redacted } from "effect";
import { FetchHttpClient } from "effect/http";
import { make } from "../src/sdk";
import { runtime } from "../tooling/worker-test";
import { commandPackage } from "./fixtures/package";

test(
  "stderr file redirects preserve binary bytes, lexical failures, write-only grants and retained inode identity",
  () =>
    Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const directory = yield* Effect.acquireRelease(
            Effect.promise(() => mkdtemp(join(tmpdir(), "boxes-stderr-"))),
            (path) => Effect.promise(() => rm(path, { recursive: true, force: true })),
          );
          const worker = yield* Effect.acquireRelease(
            Effect.sync(() => runtime(directory)),
            (worker) => Effect.promise(() => worker.dispose()),
          );
          const url = (yield* Effect.promise(() => worker.ready)).toString();
          const admin = yield* make({ url, token: Redacted.make("cirro-local-test-credential") });
          const id = "stderr";
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
          const empty = yield* client.action(id, {
            op: "process.run",
            id: "empty",
            language: "shell",
            source: "true 2> /tmp/empty",
          });
          expect(empty.output).toMatchObject({ exitCode: 0, stdout: "", stderr: "" });
          expect(
            (yield* client.action(id, { op: "filesystem.readFile", path: "/tmp/empty" })).content,
          ).toBe("");
          const binary = Buffer.from(
            yield* Effect.promise(() => Bun.file("dist/wasi-raw-stdio.wasm").arrayBuffer()),
          );
          yield* client.action(id, {
            op: "filesystem.writeFile",
            path: "/tmp/package",
            content: commandPackage(binary).toString("base64"),
            encoding: "base64",
          });
          yield* client.action(id, { op: "software.install", source: { path: "/tmp/package" } });
          const stdout = Buffer.from(Array.from({ length: 70003 }, (_, index) => index % 256));
          const stderr = Buffer.from([255, 0, 128, 195, 40, 254]);
          const failure = yield* client.action(id, {
            op: "process.run",
            id: "binary",
            language: "shell",
            source: "probe failure 2> /tmp/error > /tmp/out",
          });
          expect(failure.output).toMatchObject({ exitCode: 7, stdout: "", stderr: "" });
          expect(
            Buffer.from(
              (yield* client.action(id, { op: "filesystem.readFile", path: "/tmp/error" })).content,
              "base64",
            ),
          ).toEqual(stderr);
          expect(
            Buffer.from(
              (yield* client.action(id, { op: "filesystem.readFile", path: "/tmp/out" })).content,
              "base64",
            ),
          ).toEqual(stdout);
          expect(
            (yield* client.action(id, {
              op: "process.output.read",
              id: "binary",
              after: null,
              maxBytes: 65536,
              maxEvents: 128,
            })).events,
          ).toHaveLength(0);
          const pipeline = yield* client.action(id, {
            op: "process.run",
            id: "pipeline",
            language: "shell",
            source: "probe failure 2>> /tmp/error | cat > /tmp/piped",
          });
          expect(pipeline.output).toMatchObject({ exitCode: 0, stdout: "", stderr: "" });
          expect(
            Buffer.from(
              (yield* client.action(id, { op: "filesystem.readFile", path: "/tmp/error" })).content,
              "base64",
            ),
          ).toEqual(Buffer.concat([stderr, stderr]));
          expect(
            Buffer.from(
              (yield* client.action(id, { op: "filesystem.readFile", path: "/tmp/piped" })).content,
              "base64",
            ),
          ).toEqual(stdout);
          for (const [index, source] of [
            "unknown-command 2> /tmp/unknown",
            "true 2> /tmp/prepared < /missing",
            "echo forbidden 2> /tmp/prepared > /missing/out",
          ].entries()) {
            const result = yield* client.action(id, {
              op: "process.run",
              id: `error-${index}`,
              language: "shell",
              source,
            });
            expect(result.output?.exitCode).not.toBe(0);
            expect(result.output?.stdout).toBe("");
            expect(result.output?.stderr).toBe("");
          }
          expect(
            (yield* client.action(id, { op: "filesystem.readFile", path: "/tmp/unknown" })).content,
          ).not.toBe("");
          expect(
            (yield* client.action(id, { op: "filesystem.readFile", path: "/tmp/prepared" }))
              .content,
          ).not.toBe("");
          const unopened = yield* client.action(id, {
            op: "process.run",
            id: "unopened",
            language: "shell",
            source: "true < /missing 2> /tmp/unopened",
          });
          expect(unopened.output?.exitCode).toBe(1);
          expect(unopened.output?.stderr).not.toBe("");
          expect(
            (yield* client.action(id, { op: "filesystem.exists", path: "/tmp/unopened" })).exists,
          ).toBe(false);
          yield* client.action(id, {
            op: "filesystem.writeFile",
            path: "/tmp/input",
            content: "",
            encoding: "utf8",
          });
          const trap = yield* client.action(id, {
            op: "process.run",
            id: "trap",
            language: "shell",
            source: "probe trap 2> /tmp/trap",
          });
          expect(trap.output?.exitCode).toBe(126);
          expect(trap.output?.stderr).toBe("");
          const trapped = Buffer.from(
            (yield* client.action(id, { op: "filesystem.readFile", path: "/tmp/trap" })).content,
            "base64",
          );
          expect(trapped.subarray(0, 6)).toEqual(stderr);
          expect(trapped.subarray(6).toString()).toContain("WASI execution failed");
          const replay = yield* client.action(id, {
            op: "process.output.read",
            id: "trap",
            after: null,
            maxBytes: 65536,
            maxEvents: 128,
          });
          expect(replay.events.every((event) => event.stream === "stdout")).toBe(true);
          const replayTail = yield* client.action(id, {
            op: "process.output.read",
            id: "trap",
            after: replay.nextCursor,
            maxBytes: 65536,
            maxEvents: 128,
          });
          expect(replayTail.events.every((event) => event.stream === "stdout")).toBe(true);
          expect(
            Buffer.concat(
              [...replay.events, ...replayTail.events].map((event) =>
                Buffer.from(event.data, "base64"),
              ),
            ),
          ).toEqual(stdout);
          yield* client.action(id, { op: "filesystem.chmod", path: "/tmp/error", mode: 0o200 });
          const writeGrant = yield* admin.mintCapability(id, {
            permissions: ["write", "execute"],
            expiresInSeconds: 600,
          });
          const writer = yield* make({ url, token: Redacted.make(writeGrant.token) });
          const append = yield* writer.action(id, {
            op: "process.run",
            id: "write-only",
            language: "shell",
            source: "head -n invalid 2>> /tmp/error",
          });
          expect(append.output).toMatchObject({ exitCode: 2, stdout: "", stderr: "" });
          yield* client.action(id, { op: "filesystem.chmod", path: "/tmp/error", mode: 0o600 });
          expect(
            Buffer.from(
              (yield* client.action(id, { op: "filesystem.readFile", path: "/tmp/error" })).content,
              "base64",
            ),
          ).toEqual(Buffer.concat([stderr, stderr, Buffer.from("invalid filter count\n")]));
          yield* client.action(id, {
            op: "filesystem.link",
            from: "/tmp/error",
            to: "/tmp/alias",
            follow: false,
          });
          const before = yield* client.action(id, {
            op: "filesystem.stat",
            path: "/tmp/error",
            follow: true,
          });
          const removed = yield* writer.action(id, {
            op: "process.run",
            id: "retained",
            language: "shell",
            source: "rm /tmp/error /missing 2> /tmp/error",
          });
          expect(removed.output?.stderr).toBe("");
          expect(
            (yield* client.action(id, { op: "filesystem.exists", path: "/tmp/error" })).exists,
          ).toBe(false);
          expect(
            (yield* client.action(id, { op: "filesystem.stat", path: "/tmp/alias", follow: true }))
              .inode,
          ).toBe(before.inode);
          expect(
            (yield* client.action(id, { op: "filesystem.readFile", path: "/tmp/alias" })).content,
          ).not.toBe("");
          yield* client.action(id, { op: "filesystem.chmod", path: "/tmp/alias", mode: 0o400 });
          const denied = yield* writer.action(id, {
            op: "process.run",
            id: "denied",
            language: "shell",
            source: "mkdir /tmp/should-not-exist 2> /tmp/alias",
          });
          expect(denied.output?.exitCode).toBe(1);
          expect(
            (yield* client.action(id, { op: "filesystem.exists", path: "/tmp/should-not-exist" }))
              .exists,
          ).toBe(false);
          yield* client.action(id, {
            op: "filesystem.writeFile",
            path: "/tmp/over-budget",
            content: "",
            encoding: "utf8",
          });
          yield* client.action(id, { op: "config.patch", policy: { maxOutputBytes: 1024 } });
          const quota = yield* client.action(id, {
            op: "process.run",
            id: "quota",
            language: "shell",
            source: `${"x".repeat(1500)} 2> /tmp/over-budget`,
          });
          expect(quota.status).toBe("failed");
          expect(
            (yield* client.action(id, { op: "filesystem.readFile", path: "/tmp/over-budget" }))
              .content,
          ).toBe("");
        }),
      ).pipe(Effect.provide(FetchHttpClient.layer)),
    ),
  15000,
);
