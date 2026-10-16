import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Redacted } from "effect";
import { FetchHttpClient } from "effect/http";
import { make, makeBinding } from "../src/sdk";
import { runtime } from "../tooling/worker-test";

test("native terminal attributes control independent flags, custom bytes, aliases, signals and validation", () =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const directory = yield* Effect.acquireRelease(
          Effect.promise(() => mkdtemp(join(tmpdir(), "boxes-termios-"))),
          (path) => Effect.promise(() => rm(path, { recursive: true, force: true })),
        );
        const worker = yield* Effect.acquireRelease(
          Effect.sync(() => runtime(directory, { controlled: false })),
          (worker) => Effect.promise(() => worker.dispose()),
        );
        const url = (yield* Effect.promise(() => worker.ready)).toString();
        const admin = yield* make({ url, token: Redacted.make("cirro-local-test-credential") });
        yield* admin.create({
          id: "attributes",
          policy: {
            networkHosts: [],
            interruptBudget: 100000,
            memoryBytes: 8388608,
            maxOutputBytes: 1048576,
          },
        });
        const grant = yield* admin.mintCapability("attributes", {
          permissions: ["read", "execute"],
          expiresInSeconds: 60,
        });
        const client = yield* makeBinding(
          yield* Effect.promise(() => worker.service),
          Redacted.make(grant.token),
        );
        const source = Buffer.from(
          yield* Effect.promise(() => Bun.file("dist/wasi-termios-pair.wasm").arrayBuffer()),
        ).toString("base64");
        const denied = yield* client
          .action("other", { op: "process.run", id: "termios", language: "wasm", source })
          .pipe(Effect.flip);
        expect(denied).toMatchObject({ status: 401 });
        const record = yield* client.action("attributes", {
          op: "process.run",
          id: "termios",
          language: "wasm",
          source,
        });
        expect(record.status).toBe("exited");
        expect(record.output).toMatchObject({
          exitCode: 0,
          stdout: "termios-verified\n",
          stderr: "",
        });
      }),
    ).pipe(
      Effect.provide(FetchHttpClient.layer),
      Effect.provideService(FetchHttpClient.RequestInit, { keepalive: false }),
    ),
  ));
