import { afterAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Schema } from "effect";
import { RunRecord, TokenResponse } from "../src/contracts";
import { runtime } from "../tooling/worker-test";
const directory = await mkdtemp(join(tmpdir(), "cirro-wasi-signals-"));
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
  "stop",
  "tstp",
  "stop-kill",
  "stop-term",
  "self-stop",
  "stop-masked",
  "stop-group",
  "stop-zero",
  "stop-clock",
] as const) {
  test(`native signal ${mode} preserves wait status, masks, peer lifetime and parent continuation`, async () => {
    const childMode =
      new Map([
        ["masked", "child-masked"],
        ["inherit-mask", "child-inherited"],
        ["self-stop", "child-stopself"],
        ["stop-masked", "child-maskstop"],
        ["stop-clock", "child-clock"],
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
      if (
        [
          "stop",
          "tstp",
          "stop-kill",
          "stop-term",
          "self-stop",
          "stop-masked",
          "stop-group",
          "stop-zero",
          "stop-clock",
        ].includes(mode)
      )
        expect(record.output?.stdout).toBe("resumed\n");
      else expect(record.output?.stdout).toBe("signaled\n");
    }
  });
}

test("durable cancellation releases a stopped root and preserves acknowledged output", async () => {
  const source = Buffer.from(
    await Bun.file(join(import.meta.dir, "../dist/wasi-signals-self-pause.wasm")).arrayBuffer(),
  ).toString("base64");
  expect(
    (
      await act({
        op: "process.spawn",
        execution: { op: "process.run", id: "self-pause", language: "wasm", source },
      })
    ).status,
  ).toBe(200);
  const checkpoints: (typeof RunRecord.Type)[] = [];
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline && checkpoints.length === 0) {
    const record = Schema.decodeUnknownSync(RunRecord)(
      await (await act({ op: "process.get", id: "self-pause" })).json(),
    );
    if (record.status === "running" && record.output?.stdout === "paused\n")
      checkpoints.push(record);
    else await Bun.sleep(20);
  }
  expect(checkpoints.length).toBe(1);
  expect((await act({ op: "process.cancel", id: "self-pause" })).status).toBe(200);
  expect((await act({ op: "process.wait", id: "self-pause", timeoutMs: 10000 })).status).toBe(409);
  const record = Schema.decodeUnknownSync(RunRecord)(
    await (await act({ op: "process.get", id: "self-pause" })).json(),
  );
  expect(record.status).toBe("cancelled");
  expect(record.output?.stdout).toBe("paused\n");
  expect(record.output?.exitCode).toBeNull();
}, 20000);
