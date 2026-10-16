import { afterAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Redacted, Schedule, Schema } from "effect";
import { FetchHttpClient } from "effect/http";
import { make } from "../src/sdk";
import { Head, Id, ProcessDelivery, ReclamationState } from "../src/contracts";
import { DriverAbortProof, DriverCleanupProof, DriverProof } from "./fixtures/sdk-binding-worker";
import { runtime } from "../tooling/worker-test";

const directory = await mkdtemp(join(tmpdir(), "boxes-tanstack-"));
const worker = runtime(directory, { binding: true });
afterAll(async () => {
  await worker.dispose();
  await rm(directory, { recursive: true, force: true });
});
test("native driver rejects preflight abort and stops pending work while preserving an earlier confirmed write", async () => {
  const url = await worker.binding();
  url.searchParams.set("driver", "abort");
  const response = await fetch(url, {
    method: "POST",
    body: Schema.encodeSync(Schema.fromJsonString(Id))("driver-abort"),
  });
  expect(response.status).toBe(200);
  const proof = Schema.decodeUnknownSync(DriverAbortProof)(await response.json());
  expect([proof.preflight, proof.cancelled]).toEqual(["AbortError", "AbortError"]);
  expect(proof.writes).toEqual(["confirmed"]);
});
test("native driver preserves callbacks, void values, context reuse and disposal through a service binding", async () => {
  const url = await worker.binding();
  url.searchParams.set("driver", "true");
  const response = await fetch(url, {
    method: "POST",
    body: Schema.encodeSync(Schema.fromJsonString(Id))("driver"),
  });
  expect(response.status).toBe(200);
  const proof = Schema.decodeUnknownSync(DriverProof)(await response.json());
  expect(proof.values).toEqual(["confirmed", true]);
  expect(proof.scratch).toEqual({ content: "Mgo=", encoding: "base64", size: 2 });
  expect(proof.voidResult).toBe(true);
  expect(proof.writes).toEqual(["confirmed"]);
  expect(proof.closed).toBe(true);
  const objects = await worker.objects;
  const page = await objects.list({ prefix: "sandboxes/context-" });
  const roots = page.objects.filter((object) => object.key.endsWith("/head.json"));
  expect(roots.length).toBeGreaterThan(0);
  for (const root of roots) {
    const object = await objects.get(root.key);
    if (object === null) return expect(object).not.toBeNull();
    expect(Schema.decodeUnknownSync(Schema.fromJsonString(Head))(await object.text()).deleted).toBe(
      true,
    );
    const id = root.key.split("/")[1];
    const data = await objects.list({ prefix: `sandboxes/${id}/` });
    expect(data.objects.map((object) => object.key)).toEqual([root.key]);
    for (const prefix of [`processes/${id}/`, `process-input/${id}/`, `schedules/${id}/`]) {
      expect((await objects.list({ prefix })).objects).toEqual([]);
    }
  }
});

test("ephemeral disposal collects more than one R2 page and tolerates concurrent closes", async () => {
  const url = await worker.binding();
  url.searchParams.set("driver", "bulk");
  const response = await fetch(url, {
    method: "POST",
    body: Schema.encodeSync(Schema.fromJsonString(Id))("driver-bulk"),
  });
  expect(response.status).toBe(200);
  expect(Schema.decodeUnknownSync(Schema.Int)(await response.json())).toBe(1024);
  const objects = await worker.objects;
  const roots = (await objects.list({ prefix: "sandboxes/context-" })).objects.filter((object) =>
    object.key.endsWith("/head.json"),
  );
  expect(roots.length).toBeGreaterThan(0);
  for (const root of roots) {
    const id = root.key.split("/")[1];
    expect(
      (await objects.list({ prefix: `sandboxes/${id}/` })).objects.map((object) => object.key),
    ).toEqual([root.key]);
    for (const prefix of [`processes/${id}/`, `process-input/${id}/`, `schedules/${id}/`])
      expect((await objects.list({ prefix })).objects).toEqual([]);
  }
}, 15000);

test("ephemeral cleanup reports queued blockers and resumes after native Queue settlement", async () => {
  const url = await worker.binding();
  url.searchParams.set("driver", "blocked");
  const response = fetch(url, {
    method: "POST",
    body: Schema.encodeSync(Schema.fromJsonString(Id))("driver-blocked"),
  });
  const objects = await worker.objects;
  const pending = await Effect.runPromise(
    Effect.promise(() => objects.list({ prefix: "processes/", include: ["customMetadata"] })).pipe(
      Effect.map((page) =>
        page.objects.find((object) => object.key.endsWith("/pending-cleanup.json")),
      ),
      Effect.repeat({
        until: (object) => object !== undefined,
        schedule: Schedule.spaced("10 millis"),
      }),
      Effect.timeout("3 seconds"),
    ),
  );
  if (pending === undefined) return expect(pending).toBeDefined();
  const id = pending.key.split("/")[1];
  await Effect.runPromise(
    Effect.gen(function* () {
      const url = (yield* Effect.promise(() => worker.ready)).toString();
      const admin = yield* make({ url, token: Redacted.make("cirro-local-test-credential") });
      const grant = yield* admin.mintCapability("driver-blocked", {
        permissions: ["read"],
        expiresInSeconds: 60,
      });
      const client = yield* make({ url, token: Redacted.make(grant.token) });
      yield* client
        .action("driver-blocked", { op: "filesystem.exists", path: "/cleanup-blocked" })
        .pipe(
          Effect.repeat({
            until: (result) => result.exists,
            schedule: Schedule.spaced("10 millis"),
          }),
          Effect.timeout("3 seconds"),
        );
    }).pipe(
      Effect.provide(FetchHttpClient.layer),
      Effect.provideService(FetchHttpClient.RequestInit, { keepalive: false }),
    ),
  );
  const control = await worker.control;
  const delivered = await control.deliver("executions", [
    {
      id: "cleanup-settle",
      timestamp: new Date(),
      attempts: 1,
      body: Schema.encodeSync(ProcessDelivery)({ key: pending.key, eTag: pending.etag }),
    },
  ]);
  expect(delivered.explicitAcks).toEqual(["cleanup-settle"]);
  const result = await response;
  expect(result.status).toBe(200);
  const proof = Schema.decodeUnknownSync(DriverCleanupProof)(await result.json());
  expect(proof.failure.sandboxId).toBe(id);
  expect(proof.failure.progress).toEqual({
    phase: "processes",
    status: "blocked",
    removed: 0,
    blocking: ["pending-cleanup"],
  });
  expect(proof.closed).toBe(true);
  expect(
    (await objects.list({ prefix: `sandboxes/${id}/` })).objects.map((object) => object.key),
  ).toEqual([`sandboxes/${id}/head.json`]);
  for (const prefix of [`processes/${id}/`, `process-input/${id}/`, `schedules/${id}/`])
    expect((await objects.list({ prefix })).objects).toEqual([]);
  const state = await objects.get(`reclamations/${id}.json`);
  if (state === null) return expect(state).not.toBeNull();
  expect(
    Schema.decodeUnknownSync(Schema.fromJsonString(ReclamationState))(await state.text()).phase,
  ).toBe("complete");
});
