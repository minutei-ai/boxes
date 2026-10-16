import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Redacted } from "effect";
import { FetchHttpClient } from "effect/http";
import { make, makeBinding } from "../src/sdk";
import { runtime } from "../tooling/worker-test";

test("native virtual-root identity and descriptor-limit getters preserve guest pointer bounds", () =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const directory = yield* Effect.acquireRelease(
          Effect.promise(() => mkdtemp(join(tmpdir(), "boxes-user-identity-"))),
          (path) => Effect.promise(() => rm(path, { recursive: true, force: true })),
        );
        const worker = yield* Effect.acquireRelease(
          Effect.sync(() => runtime(directory, { controlled: false })),
          (worker) => Effect.promise(() => worker.dispose()),
        );
        const admin = yield* make({
          url: (yield* Effect.promise(() => worker.ready)).toString(),
          token: Redacted.make("cirro-local-test-credential"),
        });
        yield* admin.create({
          id: "user-identity",
          policy: {
            networkHosts: [],
            interruptBudget: 100000,
            memoryBytes: 8388608,
            maxOutputBytes: 1048576,
          },
        });
        const grant = yield* admin.mintCapability("user-identity", {
          permissions: ["read", "execute"],
          expiresInSeconds: 600,
        });
        const client = yield* makeBinding(
          yield* Effect.promise(() => worker.service),
          Redacted.make(grant.token),
        );
        const bytes = yield* Effect.promise(() => Bun.file("dist/wasi-user-identity.wasm").bytes());
        const record = yield* client.action("user-identity", {
          op: "process.run",
          id: "run",
          language: "wasm",
          source: Buffer.from(bytes).toString("base64"),
        });
        expect(record.status).toBe("exited");
        expect(record.output).toMatchObject({
          exitCode: 0,
          stdout: "virtual identity and resource bounds verified\n",
        });
        expect((yield* client.action("user-identity", { op: "vm.status" })).id).toBe(
          "user-identity",
        );
      }),
    ).pipe(Effect.provide(FetchHttpClient.layer)),
  ));
