import { afterAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Schema } from "effect";
import { RunRecord, TokenResponse, ErrorResponse, ProcessPage } from "../src/contracts";
import wasmModuleBytes from "../src/wasm-module-bytes.json";
import { runtime } from "../tooling/runtime";

const directory = await mkdtemp(join(tmpdir(), "cirro-large-wasm-"));
const mf = runtime(directory);
const admin = "cirro-local-test-credential";
const post = async (path: string, credential: string, body: unknown) =>
  fetch(new URL(path, await mf.ready), {
    method: "POST",
    headers: { authorization: `Bearer ${credential}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
const created = await post("/v1/sandboxes", admin, {
  id: "large-wasm",
  policy: {
    networkHosts: [],
    interruptBudget: 1000,
    memoryBytes: 8388608,
    maxOutputBytes: 1048576,
  },
});
expect(created.status).toBe(201);
const minted = await post("/v1/sandboxes/large-wasm/capabilities", admin, {
  permissions: ["read", "write", "execute", "manage"],
  expiresInSeconds: 3600,
});
const token = Schema.decodeUnknownSync(TokenResponse)(await minted.json()).token;
const act = (body: unknown) => post("/v1/sandboxes/large-wasm/action", token, body);
const bytes = Buffer.from(
  await Bun.file(join(import.meta.dir, "../dist/wasi-large.wasm")).arrayBuffer(),
);
afterAll(async () => {
  await mf.dispose();
  await rm(directory, { recursive: true, force: true });
});

test("a module above two MiB executes inline and from a persisted file in the real Worker", async () => {
  expect(bytes.length).toBeGreaterThan(2097152);
  expect(bytes.length).toBeLessThan(wasmModuleBytes);
  const inline = await act({
    op: "process.run",
    id: "inline",
    language: "wasm",
    source: bytes.toString("base64"),
  });
  expect(inline.status).toBe(200);
  const record = Schema.decodeUnknownSync(RunRecord)(await inline.json());
  expect(record.status).toBe("exited");
  expect(record.output?.result).toBe(165);
  expect(record.output?.exitCode).toBe(0);
  expect(
    (
      await act({
        op: "filesystem.writeFile",
        path: "/tmp/large.wasm",
        content: bytes.toString("base64"),
        encoding: "base64",
      })
    ).status,
  ).toBe(200);
  const fromFile = await act({ op: "wasm.executeFile", id: "from-file", path: "/tmp/large.wasm" });
  expect(fromFile.status).toBe(200);
  expect(Schema.decodeUnknownSync(RunRecord)(await fromFile.json()).output).toEqual(record.output);
  const restored = await act({ op: "process.get", id: "from-file" });
  expect(Schema.decodeUnknownSync(RunRecord)(await restored.json()).sourceHash).toBeDefined();
}, 15000);

test("oversized files are rejected before receipt creation and script limits remain unchanged", async () => {
  expect(
    (
      await act({
        op: "filesystem.writeFile",
        path: "/tmp/oversized.wasm",
        content: Buffer.alloc(wasmModuleBytes + 1).toString("base64"),
        encoding: "base64",
      })
    ).status,
  ).toBe(200);
  const oversized = await act({
    op: "wasm.executeFile",
    id: "oversized",
    path: "/tmp/oversized.wasm",
  });
  expect(oversized.status).toBe(413);
  expect(Schema.decodeUnknownSync(ErrorResponse)(await oversized.json()).error).toBe("EFBIG");
  const inlineOversized = await act({
    op: "process.run",
    id: "inline-oversized",
    language: "wasm",
    source: Buffer.alloc(wasmModuleBytes + 1).toString("base64"),
  });
  expect(inlineOversized.status).toBe(413);
  expect(Schema.decodeUnknownSync(ErrorResponse)(await inlineOversized.json()).error).toBe("EFBIG");
  const script = await act({
    op: "process.run",
    id: "script-too-large",
    language: "javascript",
    source: " ".repeat(1048577),
  });
  expect(script.status).toBe(400);
  const page = Schema.decodeUnknownSync(ProcessPage)(
    await (await act({ op: "process.list", cursor: null, limit: 50 })).json(),
  );
  expect(
    page.items.some(
      (item) =>
        item.id === "oversized" || item.id === "inline-oversized" || item.id === "script-too-large",
    ),
  ).toBe(false);
}, 15000);
