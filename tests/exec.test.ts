import { afterAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Schema } from "effect";
import { RunRecord, TokenResponse } from "../src/contracts";
import { runtime } from "../tooling/worker-test";
const directory = await mkdtemp(join(tmpdir(), "cirro-wasi-exec-"));
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
      id: "exec",
      policy: {
        networkHosts: [],
        interruptBudget: 1000,
        memoryBytes: 8388608,
        maxOutputBytes: 1048576,
      },
    })
  ).status,
).toBe(201);
const minted = await post("/v1/sandboxes/exec/capabilities", "cirro-local-test-credential", {
  permissions: ["read", "write", "execute"],
  expiresInSeconds: 3600,
});
const token = Schema.decodeUnknownSync(TokenResponse)(await minted.json()).token;
const act = (body: unknown) => post("/v1/sandboxes/exec/action", token, body);
afterAll(async () => {
  await mf.dispose();
  await rm(directory, { recursive: true, force: true });
});

expect(
  (await act({ op: "filesystem.writeFile", path: "/tmp/value", content: "abc", encoding: "utf8" }))
    .status,
).toBe(200);
const image = Buffer.from(
  await Bun.file(join(import.meta.dir, "../dist/wasi-exec-image.wasm")).arrayBuffer(),
).toString("base64");
expect(
  (
    await act({
      op: "filesystem.writeFile",
      path: "/tmp/next.wasm",
      content: image,
      encoding: "base64",
    })
  ).status,
).toBe(200);
expect((await act({ op: "filesystem.chmod", path: "/tmp/next.wasm", mode: 493 })).status).toBe(200);
expect(
  (
    await act({
      op: "filesystem.writeFile",
      path: "/tmp/invalid",
      content: "invalid module",
      encoding: "utf8",
    })
  ).status,
).toBe(200);
expect((await act({ op: "filesystem.chmod", path: "/tmp/invalid", mode: 493 })).status).toBe(200);
expect(
  (await act({ op: "filesystem.writeFile", path: "/tmp/data", content: "ABC", encoding: "utf8" }))
    .status,
).toBe(200);
expect((await act({ op: "filesystem.chmod", path: "/tmp/data", mode: 420 })).status).toBe(200);
for (const [mode, path] of [
  ["path", "/tmp/parent.wasm"],
  ["leaf", "/tmp/leaf.wasm"],
] as const) {
  const content = Buffer.from(
    await Bun.file(join(import.meta.dir, `../dist/wasi-exec-${mode}.wasm`)).arrayBuffer(),
  ).toString("base64");
  expect(
    (await act({ op: "filesystem.writeFile", path, content, encoding: "base64" })).status,
  ).toBe(200);
  expect((await act({ op: "filesystem.chmod", path, mode: 493 })).status).toBe(200);
}
for (const mode of ["start", "start-trap"] as const) {
  const content = Buffer.from(
    await Bun.file(join(import.meta.dir, `../dist/wasi-exec-image-${mode}.wasm`)).arrayBuffer(),
  ).toString("base64");
  const path = `/tmp/${mode}.wasm`;
  expect(
    (await act({ op: "filesystem.writeFile", path, content, encoding: "base64" })).status,
  ).toBe(200);
  expect((await act({ op: "filesystem.chmod", path, mode: 493 })).status).toBe(200);
}
for (const [mode, result, exit, stdout] of [
  ["path", 7, 0, "1B"],
  ["start", 7, 0, "Z1B"],
  ["fexec", 7, 0, "1B"],
  ["child", 0, 0, "2B"],
  ["children", 7, 0, "1B"],
  ["loop", 7, 0, "1B"],
  ["signal", null, 138, "1B"],
  ["pending", null, 130, "1B"],
  ["missing", 44, 0, ""],
  ["invalid", 45, 0, ""],
  ["denied", 2, 0, ""],
  ["badfd", 8, 0, ""],
] as const) {
  test(`exec ${mode} preserves process state and commits only a valid image`, async () => {
    const source = Buffer.from(
      await Bun.file(join(import.meta.dir, `../dist/wasi-exec-${mode}.wasm`)).arrayBuffer(),
    ).toString("base64");
    const response = await act({ op: "process.run", id: mode, language: "wasm", source });
    expect(response.status).toBe(200);
    const record = Schema.decodeUnknownSync(RunRecord)(await response.json());
    expect(record.status).toBe("exited");
    expect(record.output?.result).toBe(result);
    expect(record.output?.exitCode).toBe(exit);
    expect(record.output?.stdout).toBe(stdout);
  });
}
test("a trapping start belongs to the new image and never resumes the old exec frame", async () => {
  const source = Buffer.from(
    await Bun.file(join(import.meta.dir, "../dist/wasi-exec-start-trap.wasm")).arrayBuffer(),
  ).toString("base64");
  const response = await act({ op: "process.run", id: "start-trap", language: "wasm", source });
  expect(response.status).toBe(200);
  const record = Schema.decodeUnknownSync(RunRecord)(await response.json());
  expect(record.status).toBe("failed");
  expect(record.output?.result).toBeNull();
  expect(record.output?.exitCode).toBeNull();
  expect(record.output?.stdout).toBe("Z");
});

test("failed script exec preserves the old frame, shared descriptor offsets and close-on-exec flags", async () => {
  const source = Buffer.from(
    await Bun.file(join(import.meta.dir, "../dist/wasi-exec-path.wasm")).arrayBuffer(),
  ).toString("base64");
  for (const item of [
    { id: "script-loop", content: "#!/tmp/next.wasm\n", errno: 32 },
    { id: "script-missing", content: "#!/tmp/absent-interpreter\n", errno: 44 },
    { id: "script-empty", content: "#! \t\n", errno: 45 },
    { id: "script-denied", content: "#!/tmp/data\n", errno: 2 },
  ]) {
    expect(
      (
        await act({
          op: "filesystem.writeFile",
          path: "/tmp/next.wasm",
          content: item.content,
          encoding: "utf8",
        })
      ).status,
    ).toBe(200);
    expect((await act({ op: "filesystem.chmod", path: "/tmp/next.wasm", mode: 493 })).status).toBe(
      200,
    );
    const response = await act({ op: "process.run", id: item.id, language: "wasm", source });
    expect(response.status).toBe(200);
    const record = Schema.decodeUnknownSync(RunRecord)(await response.json());
    expect(record.status).toBe("exited");
    expect(record.output?.result).toBe(item.errno);
    expect(record.output?.exitCode).toBe(0);
    expect(record.output?.stdout).toBe("");
  }
  expect(
    (
      await act({
        op: "filesystem.writeFile",
        path: "/tmp/next.wasm",
        content: image,
        encoding: "base64",
      })
    ).status,
  ).toBe(200);
});
