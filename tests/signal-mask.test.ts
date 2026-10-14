import { afterAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Schema } from "effect";
import { RunRecord, TokenResponse } from "../src/contracts";
import { runtime } from "../tooling/runtime";

const directory = await mkdtemp(join(tmpdir(), "cirro-signal-mask-"));
const mf = runtime(directory);
const admin = "cirro-local-test-credential";
const post = async (path: string, credential: string, body: unknown) =>
  fetch(new URL(path, await mf.ready), {
    method: "POST",
    headers: { authorization: `Bearer ${credential}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
const created = await post("/v1/sandboxes", admin, {
  id: "signal-mask",
  policy: {
    networkHosts: [],
    interruptBudget: 1000,
    memoryBytes: 8388608,
    maxOutputBytes: 1048576,
  },
});
expect(created.status).toBe(201);
const minted = await post("/v1/sandboxes/signal-mask/capabilities", admin, {
  permissions: ["execute"],
  expiresInSeconds: 3600,
});
const token = Schema.decodeUnknownSync(TokenResponse)(await minted.json()).token;
const act = (body: unknown) => post("/v1/sandboxes/signal-mask/action", token, body);
afterAll(async () => {
  await mf.dispose();
  await rm(directory, { recursive: true, force: true });
});

test("mask operations cover both 32-bit halves, protect unmaskable signals and reject invalid memory atomically", async () => {
  const source = Buffer.from(
    await Bun.file(join(import.meta.dir, "../dist/wasi-signal-mask.wasm")).arrayBuffer(),
  ).toString("base64");
  for (const id of ["first", "isolated"] as const) {
    const response = await act({ op: "process.run", id, language: "wasm", source });
    expect(response.status).toBe(200);
    const record = Schema.decodeUnknownSync(RunRecord)(await response.json());
    expect(record.status).toBe("exited");
    expect(record.output?.result).toBe(0);
    expect(record.output?.exitCode).toBe(0);
  }
});
