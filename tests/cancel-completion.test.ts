import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Redacted, Schema } from "effect";
import { FetchHttpClient } from "effect/http";
import { RunSummary } from "../src/contracts";
import { make } from "../src/sdk";
import { runtime } from "../tooling/worker-test";

test("cancellation observes actual completion after losing its conditional write without replaying execution", () =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const directory = yield* Effect.acquireRelease(
          Effect.promise(() => mkdtemp(join(tmpdir(), "boxes-cancel-completion-"))),
          (path) => Effect.promise(() => rm(path, { recursive: true, force: true })),
        );
        const worker = yield* Effect.acquireRelease(
          Effect.sync(() => runtime(directory, { controlled: false })),
          (worker) => Effect.promise(() => worker.dispose()),
        );
        const url = (yield* Effect.promise(() => worker.ready)).toString();
        const admin = yield* make({ url, token: Redacted.make("cirro-local-test-credential") });
        yield* admin.create({
          id: "cancel-completion",
          policy: {
            networkHosts: [],
            interruptBudget: 1000,
            memoryBytes: 8388608,
            maxOutputBytes: 1048576,
          },
        });
        const grant = yield* admin.mintCapability("cancel-completion", {
          permissions: ["read", "execute"],
          expiresInSeconds: 60,
        });
        const client = yield* make({ url, token: Redacted.make(grant.token) });
        yield* client.action("cancel-completion", {
          op: "process.spawn",
          execution: {
            op: "process.run",
            id: "job",
            language: "javascript",
            source: "export default () => 42;",
          },
        });
        const control = yield* Effect.promise(() => worker.control);
        const response = yield* Effect.promise(() =>
          control.cancelAfterCompletion("cancel-completion", grant.token, "job"),
        );
        expect(response.deliveries).toBe(1);
        expect(response.status).toBe(200);
        const summary = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(RunSummary))(
          response.body,
        );
        expect(summary.status).toBe("exited");
        const record = yield* client.action("cancel-completion", { op: "process.get", id: "job" });
        expect(record.output?.result).toBe(42);
        const objects = yield* Effect.promise(() => worker.objects);
        const before = yield* Effect.promise(() =>
          objects.head("processes/cancel-completion/job.json"),
        );
        expect(
          yield* client.action("cancel-completion", { op: "process.cancel", id: "job" }),
        ).toEqual(summary);
        expect(
          (yield* Effect.promise(() => objects.head("processes/cancel-completion/job.json")))?.etag,
        ).toBe(before?.etag);
      }),
    ).pipe(
      Effect.provide(FetchHttpClient.layer),
      Effect.provideService(FetchHttpClient.RequestInit, { keepalive: false }),
    ),
  ));
