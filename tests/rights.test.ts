import { afterAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Schema } from "effect";
import {
  ProcessDelivery,
  RunRecord,
  StoredRun,
  TokenResponse,
  FileContent,
  Exists,
} from "../src/contracts";
import { runtime } from "../tooling/worker-test";

const directory = await mkdtemp(join(tmpdir(), "boxes-rights-"));
const first = runtime(directory, { advance: 30000 });
const instances = [first];
const post = async (
  instance: ReturnType<typeof runtime>,
  path: string,
  token: string,
  body: unknown,
) =>
  fetch(new URL(path, await instance.ready), {
    method: "POST",
    keepalive: false,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
const path = "/v1/sandboxes/rights/action";
const created = await post(first, "/v1/sandboxes", "cirro-local-test-credential", {
  id: "rights",
  policy: {
    networkHosts: [],
    interruptBudget: 1000,
    memoryBytes: 8388608,
    maxOutputBytes: 1048576,
  },
});
expect(created.status).toBe(201);
const token = Schema.decodeUnknownSync(TokenResponse)(
  await (
    await post(first, "/v1/sandboxes/rights/capabilities", "cirro-local-test-credential", {
      permissions: ["read", "write", "execute"],
      expiresInSeconds: 3600,
    })
  ).json(),
).token;
afterAll(async () => {
  for (const instance of instances) await instance.dispose();
  await rm(directory, { recursive: true, force: true });
});
test("WASI rights reduction denies escalation and preserves files, stdio and duplicate permissions", async () => {
  const source = Buffer.from(
    await Bun.file(join(import.meta.dir, "../dist/wasi-attenuation.wasm")).arrayBuffer(),
  ).toString("base64");
  const response = await post(first, path, token, {
    op: "process.run",
    id: "rights",
    language: "wasm",
    source,
  });
  expect(response.status).toBe(200);
  const record = Schema.decodeUnknownSync(RunRecord)(await response.json());
  expect(record.output?.stderr).toBe("");
  expect(record.status).toBe("exited");
  expect(record.output?.exitCode).toBe(0);
  expect(record.output?.stdout).toBe("rights reductions retained across aliases and suspension\n");
  const file = Schema.decodeUnknownSync(FileContent)(
    await (
      await post(first, path, token, { op: "filesystem.readFile", path: "/tmp/rights" })
    ).json(),
  );
  expect(Buffer.from(file.content, file.encoding).toString()).toBe("retained");
  expect(
    Schema.decodeUnknownSync(Exists)(
      await (
        await post(first, path, token, { op: "filesystem.exists", path: "/tmp/denied" })
      ).json(),
    ).exists,
  ).toBe(false);
});
test("reduced WASI rights survive a Queue checkpoint and replacement Worker", async () => {
  const source = Buffer.from(
    await Bun.file(join(import.meta.dir, "../dist/wasi-attenuation-checkpoint.wasm")).arrayBuffer(),
  ).toString("base64");
  expect(
    (
      await post(first, path, token, {
        op: "process.spawn",
        execution: { op: "process.run", id: "checkpoint", language: "wasm", source },
      })
    ).status,
  ).toBe(200);
  const key = "processes/rights/checkpoint.json";
  const objects = await first.objects;
  const pending = await objects.head(key);
  if (pending === null) return expect(pending).not.toBeNull();
  await (
    await first.control
  ).deliver("executions", [
    {
      id: "first",
      timestamp: new Date(),
      attempts: 1,
      body: Schema.encodeSync(ProcessDelivery)({ key, eTag: pending.etag }),
    },
  ]);
  const paused = await objects.get(key);
  if (paused === null) return expect(paused).not.toBeNull();
  const receipt = Schema.decodeUnknownSync(Schema.fromJsonString(StoredRun))(await paused.text());
  expect(receipt.status).toBe("queued");
  expect(receipt.checkpointCount).toBe(1);
  await first.dispose();
  const second = runtime(directory, { clockStart: first.time, advance: 1000 });
  instances.splice(0, 1, second);
  const retained = await (await second.objects).head(key);
  if (retained === null) return expect(retained).not.toBeNull();
  await (
    await second.control
  ).deliver("executions", [
    {
      id: "second",
      timestamp: new Date(),
      attempts: 1,
      body: Schema.encodeSync(ProcessDelivery)({ key, eTag: retained.etag }),
    },
  ]);
  const response = await post(second, path, token, {
    op: "process.wait",
    id: "checkpoint",
    timeoutMs: 0,
  });
  expect(response.status).toBe(200);
  const record = Schema.decodeUnknownSync(RunRecord)(await response.json());
  expect(record.output?.stderr).toBe("");
  expect(record.status).toBe("exited");
  expect(record.output?.exitCode).toBe(0);
  expect(record.output?.stdout).toBe(
    "rights checkpoint\nrights reductions retained across aliases and suspension\n",
  );
});
