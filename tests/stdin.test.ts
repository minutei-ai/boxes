import { afterAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Schema } from "effect";
import { RunRecord, TokenResponse, InputReceipt, InputHead } from "../src/contracts";
import { runtime } from "../tooling/worker-test";
const directory = await mkdtemp(join(tmpdir(), "cirro-wasi-stdin-"));
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
      id: "stdin",
      policy: {
        networkHosts: [],
        interruptBudget: 100000,
        memoryBytes: 8388608,
        maxOutputBytes: 1048576,
      },
    })
  ).status,
).toBe(201);
const minted = await post("/v1/sandboxes/stdin/capabilities", "cirro-local-test-credential", {
  permissions: ["read", "write", "execute"],
  expiresInSeconds: 3600,
});
const token = Schema.decodeUnknownSync(TokenResponse)(await minted.json()).token;
const act = (body: unknown) => post("/v1/sandboxes/stdin/action", token, body);
afterAll(async () => {
  await mf.dispose();
  await rm(directory, { recursive: true, force: true });
});

const source = Buffer.from(
  await Bun.file(join(import.meta.dir, "../dist/wasi-stdin.wasm")).arrayBuffer(),
).toString("base64");
const start = (id: string, seed = "") =>
  act({
    op: "process.spawn",
    stdinMode: "pipe",
    execution: {
      op: "process.run",
      id,
      language: "wasm",
      source,
      stdin: { content: seed, encoding: "utf8" },
    },
  });
const observe = async (id: string) => {
  const response = await act({ op: "process.wait", id, timeoutMs: 10_000 });
  expect(response.status).toBe(200);
  return Schema.decodeUnknownSync(RunRecord)(await response.json());
};

test("interactive stdin persists initial bytes, deduplicates retry, echoes binary data and finishes only after EOF", async () => {
  expect((await start("echo", "seed:")).status).toBe(200);
  expect((await act({ op: "process.wait", id: "echo", timeoutMs: 0 })).status).toBe(408);
  const data = Buffer.from("hello\0world");
  const mutation = {
    op: "process.stdin.write",
    id: "echo",
    offset: 5,
    content: data.toString("base64"),
    encoding: "base64",
  };
  const written = await act(mutation);
  expect(written.status).toBe(200);
  expect(Schema.decodeUnknownSync(InputReceipt)(await written.json()).offset).toBe(16);
  const retry = await act(mutation);
  expect(retry.status).toBe(200);
  expect(Schema.decodeUnknownSync(InputReceipt)(await retry.json()).offset).toBe(16);
  expect(
    (await act({ ...mutation, content: Buffer.from("different").toString("base64") })).status,
  ).toBe(409);
  expect((await act({ op: "process.stdin.close", id: "echo", offset: 5 })).status).toBe(409);
  expect((await act({ op: "process.stdin.close", id: "echo", offset: 16 })).status).toBe(200);
  expect((await act({ op: "process.stdin.close", id: "echo", offset: 16 })).status).toBe(200);
  expect(
    (
      await act({
        op: "process.stdin.write",
        id: "echo",
        offset: 16,
        content: "x",
        encoding: "utf8",
      })
    ).status,
  ).toBe(409);
  const finished = await observe("echo");
  expect(finished.status).toBe("exited");
  expect(finished.output?.exitCode).toBe(0);
  expect(finished.output?.stdout).toBe("ready\nseed:hello\0world\nbytes=16\n");
});

test("input larger than the native pipe drains through bounded blocks in order", async () => {
  expect((await start("large")).status).toBe(200);
  for (const index of [0, 1, 2]) {
    const data = Buffer.alloc(65_536, 65 + index);
    expect(
      (
        await act({
          op: "process.stdin.write",
          id: "large",
          offset: index * 65_536,
          content: data.toString("base64"),
          encoding: "base64",
        })
      ).status,
    ).toBe(200);
  }
  expect((await act({ op: "process.stdin.close", id: "large", offset: 196_608 })).status).toBe(200);
  const finished = await observe("large");
  expect(finished.output?.stdout).toBe(
    "ready\n" + "A".repeat(65_536) + "B".repeat(65_536) + "C".repeat(65_536) + "\nbytes=196608\n",
  );
});

test("cancel interrupts a process blocked on interactive stdin", async () => {
  expect((await start("cancel")).status).toBe(200);
  expect((await act({ op: "process.wait", id: "cancel", timeoutMs: 500 })).status).toBe(408);
  const active = Schema.decodeUnknownSync(RunRecord)(
    await (await act({ op: "process.get", id: "cancel" })).json(),
  );
  expect(active.status).toBe("running");
  const cancelled = await act({ op: "process.cancel", id: "cancel" });
  expect(cancelled.status).toBe(200);
  const wait = await act({ op: "process.wait", id: "cancel", timeoutMs: 5000 });
  expect(wait.status).toBe(409);
  const record = Schema.decodeUnknownSync(RunRecord)(
    await (await act({ op: "process.get", id: "cancel" })).json(),
  );
  expect(record.status).toBe("cancelled");
  expect(
    (
      await act({
        op: "process.stdin.write",
        id: "cancel",
        offset: 0,
        content: "late",
        encoding: "utf8",
      })
    ).status,
  ).toBe(409);
});

test("stdin mutation enforces execute permission and canonical bytes", async () => {
  expect((await start("grant")).status).toBe(200);
  const restricted = Schema.decodeUnknownSync(TokenResponse)(
    await (
      await post("/v1/sandboxes/stdin/capabilities", "cirro-local-test-credential", {
        permissions: ["read"],
        expiresInSeconds: 3600,
      })
    ).json(),
  ).token;
  expect(
    (
      await post("/v1/sandboxes/stdin/action", restricted, {
        op: "process.stdin.write",
        id: "grant",
        offset: 0,
        content: "x",
        encoding: "utf8",
      })
    ).status,
  ).toBe(403);
  expect(
    (
      await act({
        op: "process.stdin.write",
        id: "grant",
        offset: 0,
        content: "!",
        encoding: "base64",
      })
    ).status,
  ).toBe(400);
  expect((await act({ op: "process.stdin.close", id: "grant", offset: 0 })).status).toBe(200);
  expect((await observe("grant")).output?.stdout).toBe("ready\n\nbytes=0\n");
});
test("closing the last stdin reader rejects further input before process exit", async () => {
  const source = Buffer.from(
    await Bun.file(join(import.meta.dir, "../dist/wasi-stdin-close.wasm")).arrayBuffer(),
  ).toString("base64");
  expect(
    (
      await act({
        op: "process.spawn",
        stdinMode: "pipe",
        execution: { op: "process.run", id: "closed-reader", language: "wasm", source },
      })
    ).status,
  ).toBe(200);
  expect((await act({ op: "process.wait", id: "closed-reader", timeoutMs: 1000 })).status).toBe(
    408,
  );
  const active = Schema.decodeUnknownSync(RunRecord)(
    await (await act({ op: "process.get", id: "closed-reader" })).json(),
  );
  expect(active.status).toBe("running");
  const status = Schema.decodeUnknownSync(InputReceipt)(
    await (await act({ op: "process.stdin.status", id: "closed-reader" })).json(),
  );
  expect(status.closed).toBe(true);
  expect(
    (
      await act({
        op: "process.stdin.write",
        id: "closed-reader",
        offset: 0,
        content: "late",
        encoding: "utf8",
      })
    ).status,
  ).toBe(409);
  expect((await observe("closed-reader")).status).toBe("exited");
}, 10000);
test("queued stdin and EOF survive replacing the Worker before guest entry", async () => {
  const persisted = await mkdtemp(join(tmpdir(), "cirro-input-restart-"));
  const first = runtime(persisted, { consume: false, controlled: false });
  const send = (instance: ReturnType<typeof runtime>, token: string, path: string, body: unknown) =>
    instance.ready.then((origin) =>
      fetch(new URL(path, origin), {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
    );
  expect(
    (
      await send(first, "cirro-local-test-credential", "/v1/sandboxes", {
        id: "retained",
        policy: {
          networkHosts: [],
          interruptBudget: 100000,
          memoryBytes: 8388608,
          maxOutputBytes: 1048576,
        },
      })
    ).status,
  ).toBe(201);
  const token = Schema.decodeUnknownSync(TokenResponse)(
    await (
      await send(first, "cirro-local-test-credential", "/v1/sandboxes/retained/capabilities", {
        permissions: ["read", "execute"],
        expiresInSeconds: 3600,
      })
    ).json(),
  ).token;
  const path = "/v1/sandboxes/retained/action";
  expect(
    (
      await send(first, token, path, {
        op: "process.spawn",
        stdinMode: "pipe",
        execution: { op: "process.run", id: "saved", language: "wasm", source },
      })
    ).status,
  ).toBe(200);
  expect(
    (
      await send(first, token, path, {
        op: "process.stdin.write",
        id: "saved",
        offset: 0,
        content: "persisted",
        encoding: "utf8",
      })
    ).status,
  ).toBe(200);
  expect(
    (await send(first, token, path, { op: "process.stdin.close", id: "saved", offset: 9 })).status,
  ).toBe(200);
  await first.dispose();
  const second = runtime(persisted, { consume: true, controlled: false });
  expect(
    (await send(second, "cirro-local-test-credential", "/v1/maintenance/process-dispatch", {}))
      .status,
  ).toBe(200);
  const response = await send(second, token, path, {
    op: "process.wait",
    id: "saved",
    timeoutMs: 10000,
  });
  expect(response.status).toBe(200);
  const record = Schema.decodeUnknownSync(RunRecord)(await response.json());
  expect(record.status).toBe("exited");
  expect(record.output?.stdout).toBe("ready\npersisted\nbytes=9\n");
  await second.dispose();
  await rm(persisted, { recursive: true, force: true });
}, 15000);
test("corrupt retained input fails before delivering bytes and leaves the Worker healthy", async () => {
  const persisted = await mkdtemp(join(tmpdir(), "cirro-input-integrity-"));
  const first = runtime(persisted, { consume: false, controlled: false });
  const send = (instance: ReturnType<typeof runtime>, token: string, path: string, body: unknown) =>
    instance.ready.then((origin) =>
      fetch(new URL(path, origin), {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
    );
  expect(
    (
      await send(first, "cirro-local-test-credential", "/v1/sandboxes", {
        id: "integrity",
        policy: {
          networkHosts: [],
          interruptBudget: 100000,
          memoryBytes: 8388608,
          maxOutputBytes: 1048576,
        },
      })
    ).status,
  ).toBe(201);
  const token = Schema.decodeUnknownSync(TokenResponse)(
    await (
      await send(first, "cirro-local-test-credential", "/v1/sandboxes/integrity/capabilities", {
        permissions: ["read", "execute"],
        expiresInSeconds: 3600,
      })
    ).json(),
  ).token;
  const path = "/v1/sandboxes/integrity/action";
  expect(
    (
      await send(first, token, path, {
        op: "process.spawn",
        stdinMode: "pipe",
        execution: { op: "process.run", id: "corrupt", language: "wasm", source },
      })
    ).status,
  ).toBe(200);
  expect(
    (
      await send(first, token, path, {
        op: "process.stdin.write",
        id: "corrupt",
        offset: 0,
        content: "input",
        encoding: "utf8",
      })
    ).status,
  ).toBe(200);
  expect(
    (await send(first, token, path, { op: "process.stdin.close", id: "corrupt", offset: 5 }))
      .status,
  ).toBe(200);
  const bucket = await first.objects;
  const object = await bucket.get("process-input/integrity/corrupt.json");
  expect(object).not.toBeNull();
  if (object === null) return;
  const head = Schema.decodeUnknownSync(Schema.fromJsonString(InputHead))(await object.text());
  const block = head.chunks[0];
  expect(block).toBeDefined();
  if (block === undefined) return;
  await bucket.put(`sandboxes/integrity/stdin/${block.hash}`, "wrong");
  await first.dispose();
  const second = runtime(persisted, { consume: true, controlled: false });
  expect(
    (await send(second, "cirro-local-test-credential", "/v1/maintenance/process-dispatch", {}))
      .status,
  ).toBe(200);
  expect(
    (await send(second, token, path, { op: "process.wait", id: "corrupt", timeoutMs: 10000 }))
      .status,
  ).toBe(500);
  const failed = Schema.decodeUnknownSync(RunRecord)(
    await (await send(second, token, path, { op: "process.get", id: "corrupt" })).json(),
  );
  expect(failed.status).toBe("failed");
  expect(failed.output?.stdout ?? "").not.toContain("wrong");
  expect(
    (
      await send(second, token, path, {
        op: "process.spawn",
        stdinMode: "pipe",
        execution: { op: "process.run", id: "healthy", language: "wasm", source },
      })
    ).status,
  ).toBe(200);
  expect(
    (await send(second, token, path, { op: "process.stdin.close", id: "healthy", offset: 0 }))
      .status,
  ).toBe(200);
  const healthy = await send(second, token, path, {
    op: "process.wait",
    id: "healthy",
    timeoutMs: 10000,
  });
  expect(healthy.status).toBe(200);
  expect(Schema.decodeUnknownSync(RunRecord)(await healthy.json()).output?.stdout).toBe(
    "ready\n\nbytes=0\n",
  );
  await second.dispose();
  await rm(persisted, { recursive: true, force: true });
}, 15000);
