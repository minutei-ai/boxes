import { afterAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Schema } from "effect";
import { FileContent, RunRecord, TokenResponse } from "../src/contracts";
import { runtime } from "../tooling/runtime";
const directory = await mkdtemp(join(tmpdir(), "cirro-wasi-child-"));
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
      id: "child",
      policy: {
        networkHosts: [],
        interruptBudget: 1000,
        memoryBytes: 8388608,
        maxOutputBytes: 1048576,
      },
    })
  ).status,
).toBe(201);
const minted = await post("/v1/sandboxes/child/capabilities", "cirro-local-test-credential", {
  permissions: ["read", "write", "execute"],
  expiresInSeconds: 3600,
});
const token = Schema.decodeUnknownSync(TokenResponse)(await minted.json()).token;
const act = (body: unknown) => post("/v1/sandboxes/child/action", token, body);
afterAll(async () => {
  await mf.dispose();
  await rm(directory, { recursive: true, force: true });
});

test("native spawn/wait shares file offsets and stdio, preserves argv/env/masks/CLOEXEC and observes and reaps a real nonzero child exit", async () => {
  const child = Buffer.from(
    await Bun.file(join(import.meta.dir, "../dist/wasi-child-child.wasm")).arrayBuffer(),
  ).toString("base64");
  expect(
    (
      await act({
        op: "filesystem.writeFile",
        path: "/tmp/child.wasm",
        content: child,
        encoding: "base64",
      })
    ).status,
  ).toBe(200);
  expect((await act({ op: "filesystem.chmod", path: "/tmp/child.wasm", mode: 493 })).status).toBe(
    200,
  );
  expect(
    (
      await act({
        op: "filesystem.writeFile",
        path: "/tmp/shared",
        content: "abc",
        encoding: "utf8",
      })
    ).status,
  ).toBe(200);
  const source = Buffer.from(
    await Bun.file(join(import.meta.dir, "../dist/wasi-child-parent.wasm")).arrayBuffer(),
  ).toString("base64");
  const response = await act({ op: "process.run", id: "family", language: "wasm", source });
  expect(response.status).toBe(200);
  const record = Schema.decodeUnknownSync(RunRecord)(await response.json());
  expect(record.status).toBe("exited");
  expect(record.output?.exitCode).toBe(0);
  expect(record.output?.result).toBe(0);
  expect(record.output?.stdout).toBe("parent\nchild\nwaited\n");
  const file = Schema.decodeUnknownSync(FileContent)(
    await (await act({ op: "filesystem.readFile", path: "/tmp/shared" })).json(),
  );
  expect(Buffer.from(file.content, file.encoding).toString()).toBe("abcX");
});

test("child image authorization and invalid image failures leave PID outputs and shared files intact", async () => {
  expect((await act({ op: "filesystem.chmod", path: "/tmp/child.wasm", mode: 420 })).status).toBe(
    200,
  );
  const source = Buffer.from(
    await Bun.file(join(import.meta.dir, "../dist/wasi-child-parent.wasm")).arrayBuffer(),
  ).toString("base64");
  const nonExecutable = Schema.decodeUnknownSync(RunRecord)(
    await (await act({ op: "process.run", id: "no-exec", language: "wasm", source })).json(),
  );
  expect(nonExecutable.output?.result).toBe(502);
  expect((await act({ op: "filesystem.chmod", path: "/tmp/child.wasm", mode: 493 })).status).toBe(
    200,
  );
  const minted = await post("/v1/sandboxes/child/capabilities", "cirro-local-test-credential", {
    permissions: ["execute"],
    expiresInSeconds: 3600,
  });
  const limited = Schema.decodeUnknownSync(TokenResponse)(await minted.json()).token;
  const deniedSource = Buffer.from(
    await Bun.file(join(import.meta.dir, "../dist/wasi-child-denied.wasm")).arrayBuffer(),
  ).toString("base64");
  const denied = Schema.decodeUnknownSync(RunRecord)(
    await (
      await post("/v1/sandboxes/child/action", limited, {
        op: "process.run",
        id: "no-read",
        language: "wasm",
        source: deniedSource,
      })
    ).json(),
  );
  expect(denied.output?.result).toBe(2);
  expect(
    (
      await act({
        op: "filesystem.writeFile",
        path: "/tmp/child.wasm",
        content: "invalid image",
        encoding: "utf8",
      })
    ).status,
  ).toBe(200);
  const invalid = Schema.decodeUnknownSync(RunRecord)(
    await (await act({ op: "process.run", id: "invalid", language: "wasm", source })).json(),
  );
  expect(invalid.output?.result).toBe(552);
  const file = Schema.decodeUnknownSync(FileContent)(
    await (await act({ op: "filesystem.readFile", path: "/tmp/shared" })).json(),
  );
  expect(Buffer.from(file.content, file.encoding).toString()).toBe("abcX");
});

test("a child rename preserves the parent's open inode metadata and shared content", async () => {
  const child = Buffer.from(
    await Bun.file(join(import.meta.dir, "../dist/wasi-child-child-rename.wasm")).arrayBuffer(),
  ).toString("base64");
  expect(
    (
      await act({
        op: "filesystem.writeFile",
        path: "/tmp/child.wasm",
        content: child,
        encoding: "base64",
      })
    ).status,
  ).toBe(200);
  const source = Buffer.from(
    await Bun.file(join(import.meta.dir, "../dist/wasi-child-parent.wasm")).arrayBuffer(),
  ).toString("base64");
  const record = Schema.decodeUnknownSync(RunRecord)(
    await (await act({ op: "process.run", id: "rename", language: "wasm", source })).json(),
  );
  expect(record.output?.result).toBe(0);
  expect(record.output?.stdout).toBe("parent\nchild\nwaited\n");
  expect((await act({ op: "filesystem.readFile", path: "/tmp/shared" })).status).toBe(404);
  const moved = Schema.decodeUnknownSync(FileContent)(
    await (await act({ op: "filesystem.readFile", path: "/tmp/moved" })).json(),
  );
  expect(Buffer.from(moved.content, moved.encoding).toString()).toBe("abcX");
});

for (const mode of ["child-trap", "child-oob"] as const) {
  test(`${mode} is reaped with a nonzero status while the parent continues writing shared files`, async () => {
    const child = Buffer.from(
      await Bun.file(join(import.meta.dir, `../dist/wasi-child-${mode}.wasm`)).arrayBuffer(),
    ).toString("base64");
    expect(
      (
        await act({
          op: "filesystem.writeFile",
          path: "/tmp/child.wasm",
          content: child,
          encoding: "base64",
        })
      ).status,
    ).toBe(200);
    expect((await act({ op: "filesystem.chmod", path: "/tmp/child.wasm", mode: 493 })).status).toBe(
      200,
    );
    expect(
      (
        await act({
          op: "filesystem.writeFile",
          path: "/tmp/shared",
          content: "abc",
          encoding: "utf8",
        })
      ).status,
    ).toBe(200);
    const source = Buffer.from(
      await Bun.file(join(import.meta.dir, "../dist/wasi-child-parent-trap.wasm")).arrayBuffer(),
    ).toString("base64");
    const response = await act({ op: "process.run", id: mode, language: "wasm", source });
    expect(response.status).toBe(200);
    const record = Schema.decodeUnknownSync(RunRecord)(await response.json());
    expect(record.status).toBe("exited");
    expect(record.output?.result).toBe(0);
    expect(record.output?.exitCode).toBe(0);
    expect(record.output?.stdout).toBe("parent\nchild\nwaited\n");
    const file = Schema.decodeUnknownSync(FileContent)(
      await (await act({ op: "filesystem.readFile", path: "/tmp/shared" })).json(),
    );
    expect(Buffer.from(file.content, file.encoding).toString()).toBe("abcXY");
  });
}
