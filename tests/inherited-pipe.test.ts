import { afterAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Schema } from "effect";
import { RunRecord, TokenResponse } from "../src/contracts";
import { runtime } from "../tooling/worker-test";
const directory = await mkdtemp(join(tmpdir(), "cirro-inherited-pipe-"));
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
      id: "inherited-pipe",
      policy: {
        networkHosts: [],
        interruptBudget: 10000,
        memoryBytes: 8388608,
        maxOutputBytes: 1048576,
      },
    })
  ).status,
).toBe(201);
const token = Schema.decodeUnknownSync(TokenResponse)(
  await (
    await post("/v1/sandboxes/inherited-pipe/capabilities", "cirro-local-test-credential", {
      permissions: ["read", "write", "execute"],
      expiresInSeconds: 3600,
    })
  ).json(),
).token;
const act = (body: unknown) => post("/v1/sandboxes/inherited-pipe/action", token, body);
afterAll(async () => {
  await mf.dispose();
  await rm(directory, { recursive: true, force: true });
});

for (const mode of ["duplex", "drain"] as const) {
  test(`inherited pipes ${mode} wake blocked guests and preserve real I/O and peer lifetime`, async () => {
    const child = Buffer.from(
      await Bun.file(
        join(import.meta.dir, `../dist/wasi-inherited-pipe-child-${mode}.wasm`),
      ).arrayBuffer(),
    ).toString("base64");
    expect(
      (
        await act({
          op: "filesystem.writeFile",
          path: "/tmp/pipe-child.wasm",
          content: child,
          encoding: "base64",
        })
      ).status,
    ).toBe(200);
    expect(
      (await act({ op: "filesystem.chmod", path: "/tmp/pipe-child.wasm", mode: 493 })).status,
    ).toBe(200);
    const source = Buffer.from(
      await Bun.file(
        join(import.meta.dir, `../dist/wasi-inherited-pipe-parent-${mode}.wasm`),
      ).arrayBuffer(),
    ).toString("base64");
    const response = await act({ op: "process.run", id: mode, language: "wasm", source });
    expect(response.status).toBe(200);
    const record = Schema.decodeUnknownSync(RunRecord)(await response.json());
    expect(record.status).toBe("exited");
    expect(record.output?.exitCode).toBe(0);
    expect(record.output?.result).toBe(0);
    const expected = { duplex: "pipe handshake\n", drain: "drained\n" };
    expect(record.output?.stdout).toBe(expected[mode]);
  }, 15000);
}

test("cancellation interrupts both guests waiting on inherited pipes and retains acknowledged output", async () => {
  const child = Buffer.from(
    await Bun.file(
      join(import.meta.dir, "../dist/wasi-inherited-pipe-child-duplex.wasm"),
    ).arrayBuffer(),
  ).toString("base64");
  expect(
    (
      await act({
        op: "filesystem.writeFile",
        path: "/tmp/pipe-child.wasm",
        content: child,
        encoding: "base64",
      })
    ).status,
  ).toBe(200);
  const source = Buffer.from(
    await Bun.file(
      join(import.meta.dir, "../dist/wasi-inherited-pipe-parent-blocked.wasm"),
    ).arrayBuffer(),
  ).toString("base64");
  expect(
    (
      await act({
        op: "process.spawn",
        execution: { op: "process.run", id: "blocked-family", language: "wasm", source },
      })
    ).status,
  ).toBe(200);
  const checkpoints: (typeof RunRecord.Type)[] = [];
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline && checkpoints.length === 0) {
    const record = Schema.decodeUnknownSync(RunRecord)(
      await (await act({ op: "process.get", id: "blocked-family" })).json(),
    );
    if (record.status === "running" && record.output?.stdout === "blocked family\n")
      checkpoints.push(record);
    else await Bun.sleep(20);
  }
  expect(checkpoints.length).toBe(1);
  expect((await act({ op: "process.cancel", id: "blocked-family" })).status).toBe(200);
  expect((await act({ op: "process.wait", id: "blocked-family", timeoutMs: 10000 })).status).toBe(
    409,
  );
  const record = Schema.decodeUnknownSync(RunRecord)(
    await (await act({ op: "process.get", id: "blocked-family" })).json(),
  );
  expect(record.status).toBe("cancelled");
  expect(record.output?.stdout).toBe("blocked family\n");
  expect(record.output?.exitCode).toBeNull();
}, 20000);
