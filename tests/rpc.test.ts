import { afterAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Redacted, Schema } from "effect";
import { make } from "../src/sdk";
import { FetchHttpClient } from "effect/http";
import { Id, ProcessDelivery } from "../src/contracts";
import { RpcProbe } from "./fixtures/sdk-binding-worker";
import { runtime } from "../tooling/worker-test";

const directory = await mkdtemp(join(tmpdir(), "boxes-rpc-"));
const worker = runtime(directory, { binding: true });
afterAll(async () => {
  await worker.dispose();
  await rm(directory, { recursive: true, force: true });
});
const probe = async (mode: string) => {
  const url = await worker.binding();
  url.searchParams.set("rpc", mode);
  const response = await fetch(url, {
    method: "POST",
    body: Schema.encodeSync(Schema.fromJsonString(Id))(`rpc-${mode}`),
  });
  expect(response.status).toBe(200);
  return Schema.decodeUnknownSync(RpcProbe)(await response.json());
};

test("native RPC binding and guest filesystem tools preserve shared inode identity", async () => {
  const result = await probe("hardlinks");
  expect(result.calls).toBe(1);
  expect(result.record?.output?.result).toEqual({
    same: true,
    links: 2,
    content: "YmluZGluZw==",
    callback: "callback",
  });
});

test("RPC callbacks preserve declared tool errors and enforce response byte bounds", async () => {
  const failure = await probe("error");
  expect(failure.calls).toBe(1);
  expect(failure.record?.output?.result).toBe("HOST_TOOL_FAILED");
  const oversized = await probe("oversize");
  expect(oversized.calls).toBe(1);
  expect(oversized.record?.output?.result).toBe("EFBIG");
});
test("RPC preserves omitted input and void tool results without substituting null", async () => {
  const result = await probe("undefined");
  expect(result.calls).toBe(1);
  expect(result.record?.output?.result).toBe(true);
});
test("invalid credentials and sandbox identity never invoke a host callback", async () => {
  for (const mode of ["credentials", "wrong-sandbox"]) {
    const result = await probe(mode);
    expect([result.calls, result.denied, result.record]).toEqual([0, 401, null]);
  }
});
test("disposal during an accepted callback prevents the next host effect", async () => {
  const result = await probe("disposal");
  expect(result.calls).toBe(1);
  expect(result.record?.status).toBe("cancelled");
  expect(result.record?.output?.result).toBeOneOf([null, undefined]);
});
test("RPC timeout terminates guest execution while accepted callback effects retain their own lifetime", async () => {
  const result = await probe("timeout");
  expect(result.calls).toBe(1);
  expect(result.record?.status).toBe("failed");
  expect(result.record?.output?.result).not.toBe("late");
});
test("native RPC persists its requested timeout as the inline recovery deadline", async () => {
  const result = await probe("deadline");
  expect(result.calls).toBe(1);
  expect(result.record?.status).toBe("exited");
  expect(result.record?.output?.result).toBe(true);
});
test("a queued execution cannot recover request-scoped callbacks", async () => {
  const result = await probe("queue");
  expect(result.calls).toBe(0);
  expect(result.record?.status).toBe("queued");
  const key = "processes/rpc-queue/rpc-probe.json";
  const object = await (await worker.objects).head(key);
  if (object === null) return expect(object).not.toBeNull();
  await (
    await worker.control
  ).deliver("executions", [
    {
      id: "detached",
      timestamp: new Date(),
      attempts: 1,
      body: Schema.encodeSync(ProcessDelivery)({ key, eTag: object.etag }),
    },
  ]);
  const record = await Effect.runPromise(
    Effect.gen(function* () {
      const admin = yield* make({
        url: (yield* Effect.promise(() => worker.ready)).toString(),
        token: Redacted.make("cirro-local-test-credential"),
      });
      const grant = yield* admin.mintCapability("rpc-queue", {
        permissions: ["read", "manage"],
        expiresInSeconds: 600,
      });
      const client = yield* make({
        url: (yield* Effect.promise(() => worker.ready)).toString(),
        token: Redacted.make(grant.token),
      });
      const stored = yield* client.action("rpc-queue", { op: "process.get", id: "rpc-probe" });
      yield* client.action("rpc-queue", { op: "vm.dispose" });
      return stored;
    }).pipe(Effect.provide(FetchHttpClient.layer)),
  );
  expect(record.status).toBe("exited");
  expect(record.output?.result).toBe("FORBIDDEN");
});
