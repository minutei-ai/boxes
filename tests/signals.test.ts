import { afterAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Schema } from "effect";
import { RunRecord, TokenResponse } from "../src/contracts";
import { runtime } from "../tooling/runtime";
const directory = await mkdtemp(join(tmpdir(), "cirro-wasi-signals-"));
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
      id: "signals",
      policy: {
        networkHosts: [],
        interruptBudget: 1000,
        memoryBytes: 8388608,
        maxOutputBytes: 1048576,
      },
    })
  ).status,
).toBe(201);
const minted = await post("/v1/sandboxes/signals/capabilities", "cirro-local-test-credential", {
  permissions: ["read", "write", "execute"],
  expiresInSeconds: 3600,
});
const token = Schema.decodeUnknownSync(TokenResponse)(await minted.json()).token;
const act = (body: unknown) => post("/v1/sandboxes/signals/action", token, body);
afterAll(async () => {
  await mf.dispose();
  await rm(directory, { recursive: true, force: true });
});

for (const mode of [
  "pid",
  "group",
  "masked",
  "unmask",
  "natural",
  "wait",
  "upper",
  "self",
  "inherit-mask",
] as const) {
  test(`native signal ${mode} preserves wait status, masks, peer lifetime and parent continuation`, async () => {
    const childMode =
      new Map([
        ["masked", "child-masked"],
        ["inherit-mask", "child-inherited"],
        ["unmask", "child-unmask"],
        ["natural", "child-natural"],
        ["wait", "child-wait"],
      ]).get(mode) ?? "child";
    const child = Buffer.from(
      await Bun.file(join(import.meta.dir, `../dist/wasi-signals-${childMode}.wasm`)).arrayBuffer(),
    ).toString("base64");
    expect(
      (
        await act({
          op: "filesystem.writeFile",
          path: "/tmp/signal-child.wasm",
          content: child,
          encoding: "base64",
        })
      ).status,
    ).toBe(200);
    expect(
      (await act({ op: "filesystem.chmod", path: "/tmp/signal-child.wasm", mode: 493 })).status,
    ).toBe(200);
    if (mode === "wait") {
      const grandchild = Buffer.from(
        await Bun.file(join(import.meta.dir, "../dist/wasi-signals-child.wasm")).arrayBuffer(),
      ).toString("base64");
      expect(
        (
          await act({
            op: "filesystem.writeFile",
            path: "/tmp/signal-grandchild.wasm",
            content: grandchild,
            encoding: "base64",
          })
        ).status,
      ).toBe(200);
      expect(
        (await act({ op: "filesystem.chmod", path: "/tmp/signal-grandchild.wasm", mode: 493 }))
          .status,
      ).toBe(200);
    }
    const source = Buffer.from(
      await Bun.file(join(import.meta.dir, `../dist/wasi-signals-${mode}.wasm`)).arrayBuffer(),
    ).toString("base64");
    const response = await act({ op: "process.run", id: mode, language: "wasm", source });
    expect(response.status).toBe(200);
    const record = Schema.decodeUnknownSync(RunRecord)(await response.json());
    expect(record.status).toBe("exited");
    if (mode === "self") {
      expect(record.output?.exitCode).toBe(137);
      expect(record.output?.stdout).toBe("");
    } else {
      expect(record.output?.exitCode).toBe(0);
      expect(record.output?.result).toBe(0);
      expect(record.output?.stdout).toBe("signaled\n");
    }
  });
}
