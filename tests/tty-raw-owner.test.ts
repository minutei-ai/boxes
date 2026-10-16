import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Redacted } from "effect";
import { FetchHttpClient } from "effect/http";
import { make, makeBinding } from "../src/sdk";
import { runtime } from "../tooling/worker-test";

test("native raw owners restore after exit, closed stdin, trap, signal and exec while preserving a parent lease", () =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const directory = yield* Effect.acquireRelease(
          Effect.promise(() => mkdtemp(join(tmpdir(), "boxes-raw-owner-"))),
          (path) => Effect.promise(() => rm(path, { recursive: true, force: true })),
        );
        const worker = yield* Effect.acquireRelease(
          Effect.sync(() => runtime(directory, { controlled: false })),
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
        for (const mode of [
          "normal",
          "closed",
          "trap",
          "signal",
          "exec",
          "failed",
          "background",
          "replacement",
        ] as const) {
          yield* client.action("terminal", {
            op: "filesystem.writeFile",
            path: `/tmp/raw-${mode}.wasm`,
            encoding: "base64",
            content: Buffer.from(
              yield* Effect.promise(() =>
                Bun.file(`dist/wasi-tty-raw-owner-${mode}.wasm`).arrayBuffer(),
              ),
            ).toString("base64"),
          });
          yield* client.action("terminal", {
            op: "filesystem.chmod",
            path: `/tmp/raw-${mode}.wasm`,
            mode: 493,
          });
        }
        const record = yield* client.action("terminal", {
          op: "process.run",
          id: "owners",
          language: "wasm",
          source: Buffer.from(
            yield* Effect.promise(() =>
              Bun.file("dist/wasi-tty-raw-owner-parent.wasm").arrayBuffer(),
            ),
          ).toString("base64"),
        });
        expect(record.status).toBe("exited");
        expect(record.output).toMatchObject({ exitCode: 0, stdout: "raw-owners-restored\n" });
      }),
    ).pipe(
      Effect.provide(FetchHttpClient.layer),
      Effect.provideService(FetchHttpClient.RequestInit, { keepalive: false }),
    ),
  ));
