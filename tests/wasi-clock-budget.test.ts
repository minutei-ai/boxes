import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Redacted } from "effect";
import { FetchHttpClient } from "effect/http";
import { make, makeBinding } from "../src/sdk";
import { runtime } from "../tooling/worker-test";

test("native clock observations preserve the I/O budget while clock loops remain fuel bounded", () =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const directory = yield* Effect.acquireRelease(
          Effect.promise(() => mkdtemp(join(tmpdir(), "boxes-clock-budget-"))),
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
        for (const probe of [
          { id: "clock-budget", budget: 100000 },
          { id: "clock-then-budget", budget: 100000 },
          { id: "clock-spin", budget: 1 },
        ]) {
          yield* admin.create({
            id: probe.id,
            policy: {
              networkHosts: [],
              interruptBudget: probe.budget,
              memoryBytes: 8388608,
              maxOutputBytes: 1048576,
            },
          });
          const grant = yield* admin.mintCapability(probe.id, {
            permissions: ["read", "execute"],
            expiresInSeconds: 600,
          });
          const client = yield* makeBinding(
            yield* Effect.promise(() => worker.service),
            Redacted.make(grant.token),
          );
          const bytes = yield* Effect.promise(() => Bun.file(`dist/wasi-${probe.id}.wasm`).bytes());
          const record = yield* client.action(probe.id, {
            op: "process.run",
            id: "run",
            language: "wasm",
            source: Buffer.from(bytes).toString("base64"),
          });
          if (probe.id === "clock-budget") {
            expect(record.status).toBe("exited");
            expect(record.output).toMatchObject({
              exitCode: 0,
              result: 42,
              stdout: "clock-observed\n",
            });
          } else {
            expect(record.status).toBe("failed");
            if (probe.id === "clock-then-budget")
              expect(record.output?.stdout).toBe("clock-observed\n");
          }
          expect((yield* client.action(probe.id, { op: "vm.status" })).id).toBe(probe.id);
        }
      }),
    ).pipe(Effect.provide(FetchHttpClient.layer)),
  ));
