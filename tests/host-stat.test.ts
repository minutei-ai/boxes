import { afterAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Schema } from "effect";
import { RunRecord, TokenResponse } from "../src/contracts";
import { runtime } from "../tooling/worker-test";

const directory = await mkdtemp(join(tmpdir(), "cirro-host-stat-"));
const mf = runtime(directory, { consume: true, controlled: false });
const admin = "cirro-local-test-credential";
const post = async (path: string, token: string, body: unknown) =>
  fetch(new URL(path, await mf.ready), {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
const created = await post("/v1/sandboxes", admin, {
  id: "host-stat",
  policy: {
    networkHosts: [],
    interruptBudget: 1000,
    memoryBytes: 8388608,
    maxOutputBytes: 1048576,
  },
});
expect(created.status).toBe(201);
const minted = await post("/v1/sandboxes/host-stat/capabilities", admin, {
  permissions: ["read", "write", "execute"],
  expiresInSeconds: 3600,
});
const token = Schema.decodeUnknownSync(TokenResponse)(await minted.json()).token;
const act = (body: unknown, credential = token) =>
  post("/v1/sandboxes/host-stat/action", credential, body);
expect(
  (
    await act({
      op: "filesystem.writeFile",
      path: "/tmp/meta",
      content: "x".repeat(513),
      encoding: "utf8",
    })
  ).status,
).toBe(200);
expect((await act({ op: "filesystem.chmod", path: "/tmp/meta", mode: 0o640 })).status).toBe(200);
expect(
  (await act({ op: "filesystem.symlink", path: "/tmp/link", target: "/tmp/meta" })).status,
).toBe(200);
expect(
  (await act({ op: "filesystem.mkdir", path: "/tmp/restricted", recursive: false })).status,
).toBe(200);
expect(
  (await act({ op: "filesystem.symlink", path: "/tmp/restricted/escape", target: "/tmp/meta" }))
    .status,
).toBe(200);
afterAll(async () => {
  await mf.dispose();
  await rm(directory, { recursive: true, force: true });
});

test("host stat ABI reads actual modes, size, blocks and ownership with exact pointer and closed-FD behavior", async () => {
  const source = Buffer.from(
    await Bun.file(join(import.meta.dir, "../dist/wasi-host-stat.wasm")).arrayBuffer(),
  ).toString("base64");
  const response = await act({ op: "process.run", id: "metadata", language: "wasm", source });
  expect(response.status).toBe(200);
  const record = Schema.decodeUnknownSync(RunRecord)(await response.json());
  expect(record.status).toBe("exited");
  expect(record.output?.result).toBe(0);
  expect(record.output?.exitCode).toBe(0);
});

test("metadata projection respects the sandbox read grant and preserves ownership outputs on failure", async () => {
  const minted = await post("/v1/sandboxes/host-stat/capabilities", admin, {
    permissions: ["execute"],
    expiresInSeconds: 3600,
  });
  const credential = Schema.decodeUnknownSync(TokenResponse)(await minted.json()).token;
  const source = Buffer.from(
    await Bun.file(join(import.meta.dir, "../dist/wasi-host-stat-denied.wasm")).arrayBuffer(),
  ).toString("base64");
  const response = await act(
    { op: "process.run", id: "denied", language: "wasm", source },
    credential,
  );
  expect(response.status).toBe(200);
  const record = Schema.decodeUnknownSync(RunRecord)(await response.json());
  expect(record.status).toBe("exited");
  expect(record.output?.result).toBe(0);
});
