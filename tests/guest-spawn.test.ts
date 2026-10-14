import { afterAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Schema } from "effect";
import { RunRecord, TokenResponse } from "../src/contracts";
import { runtime } from "../tooling/runtime";

const directory = await mkdtemp(join(tmpdir(), "cirro-guest-spawn-"));
const mf = runtime(directory);
const post = async (path: string, token: string, body: unknown) =>
  fetch(new URL(path, await mf.ready), {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
expect(
  (
    await post("/v1/sandboxes", "cirro-local-test-credential", {
      id: "serial-spawn",
      policy: {
        networkHosts: [],
        interruptBudget: 1000,
        memoryBytes: 8388608,
        maxOutputBytes: 1048576,
      },
    })
  ).status,
).toBe(201);
const minted = await post(
  "/v1/sandboxes/serial-spawn/capabilities",
  "cirro-local-test-credential",
  {
    permissions: ["execute", "read"],
    expiresInSeconds: 3600,
  },
);
const token = Schema.decodeUnknownSync(TokenResponse)(await minted.json()).token;
const act = (body: unknown) => post("/v1/sandboxes/serial-spawn/action", token, body);
afterAll(async () => {
  await mf.dispose();
  await rm(directory, { recursive: true, force: true });
});

test("a queued guest can reserve another queued execution and finish under the serial native consumer", async () => {
  const started = await act({
    op: "process.spawn",
    execution: {
      op: "process.run",
      id: "parent",
      language: "javascript",
      source:
        'export default async ({tools}) => (await tools.call({op:"process.spawn",execution:{op:"process.run",id:"child",language:"javascript",source:"export default () => 73"}})).id',
    },
  });
  expect(started.status).toBe(200);
  const parentResponse = await act({ op: "process.wait", id: "parent", timeoutMs: 10000 });
  expect(parentResponse.status).toBe(200);
  const parent = Schema.decodeUnknownSync(RunRecord)(await parentResponse.json());
  expect(parent.output?.exitCode).toBe(0);
  expect(parent.output?.result).toBe("child");
  const childResponse = await act({ op: "process.wait", id: "child", timeoutMs: 10000 });
  expect(childResponse.status).toBe(200);
  const child = Schema.decodeUnknownSync(RunRecord)(await childResponse.json());
  expect(child.output?.exitCode).toBe(0);
  expect(child.output?.result).toBe(73);
});
