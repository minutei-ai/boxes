import { afterAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Schema } from "effect";
import { RunRecord, TokenResponse } from "../src/contracts";
import { runtime } from "../tooling/worker-test";

const directory = await mkdtemp(join(tmpdir(), "cirro-wasi-slices-"));
const mf = runtime(directory, { consume: true, controlled: false });
const post = async (path: string, token: string, body: unknown) =>
  fetch(new URL(path, await mf.ready), {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
expect(
  (
    await post("/v1/sandboxes", "cirro-local-test-credential", {
      id: "slices",
      policy: {
        networkHosts: [],
        interruptBudget: 100000,
        memoryBytes: 8388608,
        maxOutputBytes: 1048576,
      },
    })
  ).status,
).toBe(201);
const minted = await post("/v1/sandboxes/slices/capabilities", "cirro-local-test-credential", {
  permissions: ["read", "execute"],
  expiresInSeconds: 3600,
});
const token = Schema.decodeUnknownSync(TokenResponse)(await minted.json()).token;
const act = (body: unknown) => post("/v1/sandboxes/slices/action", token, body);
afterAll(async () => {
  await mf.dispose();
  await rm(directory, { recursive: true, force: true });
});

test("fuel resumption preserves the guest stack, result and captured output", async () => {
  const source = Buffer.from(
    await Bun.file(join(import.meta.dir, "../dist/wasi-slices-finite.wasm")).arrayBuffer(),
  ).toString("base64");
  const response = await act({ op: "process.run", id: "finite", language: "wasm", source });
  expect(response.status).toBe(200);
  const record = Schema.decodeUnknownSync(RunRecord)(await response.json());
  expect(record.status).toBe("exited");
  expect(record.output?.exitCode).toBe(0);
  expect(record.output?.result).toBe(352);
  expect(record.output?.stdout).toBe("cpu loop started\n");
});

test("a WASI CPU loop with no host waits publishes a checkpoint and observes explicit cancellation", async () => {
  const source = Buffer.from(
    await Bun.file(join(import.meta.dir, "../dist/wasi-slices-infinite.wasm")).arrayBuffer(),
  ).toString("base64");
  expect(
    (
      await act({
        op: "process.spawn",
        execution: { op: "process.run", id: "infinite", language: "wasm", source },
      })
    ).status,
  ).toBe(200);
  const checkpoints: (typeof RunRecord.Type)[] = [];
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline && checkpoints.length === 0) {
    const response = await act({ op: "process.get", id: "infinite" });
    const record = Schema.decodeUnknownSync(RunRecord)(await response.json());
    if (record.status === "running" && record.output?.stdout === "cpu loop started\n")
      checkpoints.push(record);
    else await Bun.sleep(20);
  }
  expect(checkpoints.length).toBe(1);
  expect(checkpoints[0]?.output?.exitCode).toBeNull();
  expect((await act({ op: "process.cancel", id: "infinite" })).status).toBe(200);
  const waited = await act({ op: "process.wait", id: "infinite", timeoutMs: 10000 });
  expect(waited.status).toBe(409);
  const inspected = Schema.decodeUnknownSync(RunRecord)(
    await (await act({ op: "process.get", id: "infinite" })).json(),
  );
  expect(inspected.status).toBe("cancelled");
  expect(inspected.output?.stdout).toBe("cpu loop started\n");
  expect(inspected.output?.exitCode).toBeNull();
}, 20000);
