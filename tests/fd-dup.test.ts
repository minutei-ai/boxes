import { afterAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Schema } from "effect";
import { RunRecord, TokenResponse, FileContent } from "../src/contracts";
import { runtime } from "../tooling/runtime";

const directory = await mkdtemp(join(tmpdir(), "cirro-fd-dup-"));
const mf = runtime(directory);
const admin = "cirro-local-test-credential";
const post = async (path: string, token: string, body: unknown) =>
  fetch(new URL(path, await mf.ready), {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
const created = await post("/v1/sandboxes", admin, {
  id: "fd-dup",
  policy: {
    networkHosts: [],
    interruptBudget: 1000,
    memoryBytes: 8388608,
    maxOutputBytes: 1048576,
  },
});
expect(created.status).toBe(201);
const minted = await post("/v1/sandboxes/fd-dup/capabilities", admin, {
  permissions: ["read", "write", "execute"],
  expiresInSeconds: 3600,
});
const token = Schema.decodeUnknownSync(TokenResponse)(await minted.json()).token;
const act = (body: unknown) => post("/v1/sandboxes/fd-dup/action", token, body);
expect(
  (await act({ op: "filesystem.writeFile", path: "/tmp/dup", content: "abcdef", encoding: "utf8" }))
    .status,
).toBe(200);
expect(
  (
    await act({
      op: "filesystem.writeFile",
      path: "/tmp/other",
      content: "other",
      encoding: "utf8",
    })
  ).status,
).toBe(200);
afterAll(async () => {
  await mf.dispose();
  await rm(directory, { recursive: true, force: true });
});

test("dup shares file position/status while descriptor flags and closure remain independent, including stdio remapping", async () => {
  const source = Buffer.from(
    await Bun.file(join(import.meta.dir, "../dist/wasi-fd-dup.wasm")).arrayBuffer(),
  ).toString("base64");
  const response = await act({
    op: "process.run",
    id: "aliases",
    language: "wasm",
    source,
    stdin: { content: "X", encoding: "utf8" },
  });
  expect(response.status).toBe(200);
  const record = Schema.decodeUnknownSync(RunRecord)(await response.json());
  expect(record.status).toBe("exited");
  expect(record.output?.result).toBe(0);
  expect(record.output?.stdout).toBe("");
  expect(record.output?.stderr).toBe("alias stderr");
  const file = Schema.decodeUnknownSync(FileContent)(
    await (await act({ op: "filesystem.readFile", path: "/tmp/dup" })).json(),
  );
  expect(Buffer.from(file.content, file.encoding).toString()).toBe("abcdefZ");
  const other = Schema.decodeUnknownSync(FileContent)(
    await (await act({ op: "filesystem.readFile", path: "/tmp/other" })).json(),
  );
  expect(Buffer.from(other.content, other.encoding).toString()).toBe("other");
});
