import { afterAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Schema } from "effect";
import {
  LiveOutputPage,
  LiveOutputCursor,
  RunRecord,
  TokenResponse,
  ErrorResponse,
} from "../src/contracts";
import { runtime } from "../tooling/runtime";

const directory = await mkdtemp(join(tmpdir(), "cirro-live-output-"));
const mf = runtime(
  directory,
  'export default { async fetch() { await new Promise(resolve => setTimeout(resolve, 2500)); return new Response("native suspension"); } };',
  2,
);
const post = async (path: string, token: string, body: unknown) =>
  fetch(new URL(path, await mf.ready), {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
const act = (id: string, token: string, body: unknown) =>
  post(`/v1/sandboxes/${id}/action`, token, body);
const setup = async (id: string) => {
  expect(
    (
      await post("/v1/sandboxes", "cirro-local-test-credential", {
        id,
        policy: {
          networkHosts: ["allowed.example"],
          interruptBudget: 1000,
          memoryBytes: 8_388_608,
          maxOutputBytes: 1_048_576,
        },
      })
    ).status,
  ).toBe(201);
  return Schema.decodeUnknownSync(TokenResponse)(
    await (
      await post(`/v1/sandboxes/${id}/capabilities`, "cirro-local-test-credential", {
        permissions: ["read", "execute", "network"],
        expiresInSeconds: 3600,
      })
    ).json(),
  ).token;
};
const page = async (id: string, token: string, after: typeof LiveOutputCursor.Type | null) => {
  const response = await act(id, token, {
    op: "process.output.readLive",
    id: "stream",
    after,
    maxBytes: 65_536,
    maxEvents: 128,
  });
  expect(response.status).toBe(200);
  return Schema.decodeUnknownSync(LiveOutputPage)(await response.json());
};
const emitted = async (id: string, token: string, after: typeof LiveOutputCursor.Type | null) => {
  const deadline = performance.now() + 10_000;
  while (performance.now() < deadline) {
    const current = await page(id, token, after);
    if (current.events.length > 0) return current;
    await Bun.sleep(50);
  }
  return Promise.reject(new Error("Output was not observed at the suspension"));
};
afterAll(async () => {
  await mf.dispose();
  await rm(directory, { recursive: true, force: true });
});

test("JS, TS and Python publish before exit with stable independent cursors and retain bytes after cancellation", async () => {
  const sources = {
    javascript:
      'export default async ({tools,console}) => { console.log("first😀"); console.error("err-one"); await tools.call({op:"network.fetch",url:"https://allowed.example/delay"}); console.log("second"); console.error("err-two"); await tools.call({op:"network.fetch",url:"https://allowed.example/delay"}); return 42; }',
    typescript:
      'export default async ({tools,console}): Promise<number> => { console.log("first😀"); console.error("err-one"); await tools.call({op:"network.fetch",url:"https://allowed.example/delay"}); console.log("second"); console.error("err-two"); await tools.call({op:"network.fetch",url:"https://allowed.example/delay"}); return 42; }',
    python:
      'import sys\nprint("first😀")\nprint("err-one",file=sys.stderr)\nawait tools.call({"op":"network.fetch","url":"https://allowed.example/delay"})\nprint("second")\nprint("err-two",file=sys.stderr)\nawait tools.call({"op":"network.fetch","url":"https://allowed.example/delay"})\n42',
  };
  for (const [language, source] of Object.entries(sources)) {
    const id = `live-${language}`;
    const token = await setup(id);
    expect(
      (
        await act(id, token, {
          op: "process.spawn",
          execution: { op: "process.run", id: "stream", language, source },
        })
      ).status,
    ).toBe(200);
    const initial = await emitted(id, token, null);
    expect(initial.state).toBe("running");
    expect(initial.availability).toBe("retained");
    const record = Schema.decodeUnknownSync(RunRecord)(
      await (await act(id, token, { op: "process.get", id: "stream" })).json(),
    );
    expect(record.output?.exitCode).toBeNull();
    expect(record.finishedAt).toBeNull();
    expect(
      (
        await act(id, token, {
          op: "process.output.read",
          id: "stream",
          after: null,
          maxBytes: 16,
          maxEvents: 1,
        })
      ).status,
    ).toBe(409);
    const next = await emitted(id, token, initial.nextCursor);
    expect(next.state).toBe("running");
    expect(next.events.find((event) => event.stream === "stderr")?.offset).toBe(
      initial.nextCursor.stderr,
    );
    expect(next.events.find((event) => event.stream === "stdout")?.offset).toBe(
      initial.nextCursor.stdout,
    );
    const stdout = [...initial.events, ...next.events]
      .filter((event) => event.stream === "stdout")
      .map((event) => Buffer.from(event.data, "base64"));
    const stderr = [...initial.events, ...next.events]
      .filter((event) => event.stream === "stderr")
      .map((event) => Buffer.from(event.data, "base64"));
    expect(Buffer.concat(stdout).toString()).toBe("first😀\nsecond\n");
    expect(Buffer.concat(stderr).toString()).toBe("err-one\nerr-two\n");
    expect((await act(id, token, { op: "process.cancel", id: "stream" })).status).toBe(200);
    const waited = await act(id, token, { op: "process.wait", id: "stream", timeoutMs: 10_000 });
    expect(waited.status).toBe(409);
    expect(Schema.decodeUnknownSync(ErrorResponse)(await waited.json()).error).toBe("ECANCELED");
    const retained = await page(id, token, null);
    expect(retained.state).toBe("cancelled");
    expect(retained.nextCursor).toEqual(next.nextCursor);
    expect((await page(id, token, next.nextCursor)).events).toEqual([]);
    const final = Schema.decodeUnknownSync(RunRecord)(
      await (await act(id, token, { op: "process.get", id: "stream" })).json(),
    );
    expect(final.output?.stdout).toBe("first😀\nsecond\n");
    expect(final.output?.exitCode).toBeNull();
  }
}, 30_000);

test("captured bytes survive a later native fuel failure without manufacturing an exit", async () => {
  const id = "live-failed";
  const token = await setup(id);
  expect(
    (
      await act(id, token, {
        op: "process.spawn",
        execution: {
          op: "process.run",
          id: "stream",
          language: "javascript",
          source:
            'export default async ({tools,console}) => { console.log("before failure"); await tools.call({op:"network.fetch",url:"https://allowed.example/delay"}); while(true) {} }',
        },
      })
    ).status,
  ).toBe(200);
  const initial = await emitted(id, token, null);
  expect(initial.state).toBe("running");
  expect(
    (await act(id, token, { op: "process.wait", id: "stream", timeoutMs: 10_000 })).status,
  ).toBe(500);
  const final = await page(id, token, null);
  expect(final.state).toBe("failed");
  expect(final.availability).toBe("retained");
  expect(Buffer.from(final.events[0]?.data ?? "", "base64").toString()).toBe("before failure\n");
  const record = Schema.decodeUnknownSync(RunRecord)(
    await (await act(id, token, { op: "process.get", id: "stream" })).json(),
  );
  expect(record.output?.exitCode).toBeNull();
}, 15_000);

test("WASI publishes captured stdout/stderr at a native suspension and preserves them through exit", async () => {
  const id = "live-wasi";
  const token = await setup(id);
  const source = Buffer.from(
    await Bun.file(join(import.meta.dir, "../dist/wasi-live-output.wasm")).arrayBuffer(),
  ).toString("base64");
  expect(
    (
      await act(id, token, {
        op: "process.spawn",
        execution: { op: "process.run", id: "stream", language: "wasm", source },
      })
    ).status,
  ).toBe(200);
  const initial = await emitted(id, token, null);
  expect(initial.state).toBe("running");
  expect(initial.events.find((event) => event.stream === "stderr")).toBeDefined();
  const cursor = initial.nextCursor;
  const record = Schema.decodeUnknownSync(RunRecord)(
    await (await act(id, token, { op: "process.get", id: "stream" })).json(),
  );
  expect(record.output?.exitCode).toBeNull();
  expect(
    (await act(id, token, { op: "process.wait", id: "stream", timeoutMs: 10_000 })).status,
  ).toBe(200);
  const tail = await page(id, token, cursor);
  expect(tail.state).toBe("exited");
  expect(tail.events.map((event) => event.stream)).toEqual(["stdout"]);
  expect(Buffer.from(tail.events[0]?.data ?? "", "base64").toString()).toBe(
    "WASI after suspension\n",
  );
}, 15_000);

test("shell snapshots expose stderr while keeping redirected stdout out of the process stream", async () => {
  const id = "live-shell";
  const token = await setup(id);
  const adminToken = Schema.decodeUnknownSync(TokenResponse)(
    await (
      await post(`/v1/sandboxes/${id}/capabilities`, "cirro-local-test-credential", {
        permissions: ["read", "write", "execute", "network"],
        expiresInSeconds: 3600,
      })
    ).json(),
  ).token;
  const source = Buffer.from(
    await Bun.file(join(import.meta.dir, "../dist/wasi-live-output.wasm")).arrayBuffer(),
  ).toString("base64");
  expect(
    (
      await act(id, adminToken, {
        op: "filesystem.writeFile",
        path: "/tmp/sleeper",
        content: source,
        encoding: "base64",
      })
    ).status,
  ).toBe(200);
  expect(
    (await act(id, adminToken, { op: "filesystem.chmod", path: "/tmp/sleeper", mode: 493 })).status,
  ).toBe(200);
  expect(
    (
      await act(id, adminToken, {
        op: "process.spawn",
        execution: {
          op: "process.run",
          id: "stream",
          language: "shell",
          source: "echo shell-before; /tmp/sleeper > /tmp/redirected; echo shell-after",
        },
      })
    ).status,
  ).toBe(200);
  const initial = await emitted(id, token, null);
  expect(initial.state).toBe("running");
  expect(
    Buffer.concat(
      initial.events
        .filter((event) => event.stream === "stdout")
        .map((event) => Buffer.from(event.data, "base64")),
    ).toString(),
  ).toBe("shell-before\n");
  expect(
    (await act(id, token, { op: "process.wait", id: "stream", timeoutMs: 10_000 })).status,
  ).toBe(200);
  const final = await page(id, token, null);
  expect(
    Buffer.concat(
      final.events
        .filter((event) => event.stream === "stdout")
        .map((event) => Buffer.from(event.data, "base64")),
    ).toString(),
  ).toBe("shell-before\nshell-after\n");
  expect(
    Buffer.concat(
      final.events
        .filter((event) => event.stream === "stderr")
        .map((event) => Buffer.from(event.data, "base64")),
    ).toString(),
  ).toBe("WASI error stream\n");
}, 15_000);

test("WASI suspension fixture reads duration after the loader-owned argv zero", async () => {
  const id = "live-argv";
  const token = await setup(id);
  const source = Buffer.from(
    await Bun.file(join(import.meta.dir, "../dist/wasi-live-output.wasm")).arrayBuffer(),
  ).toString("base64");
  const response = await act(id, token, {
    op: "process.run",
    id: "duration",
    language: "wasm",
    source,
    args: ["1"],
  });
  expect(response.status).toBe(200);
  const record = Schema.decodeUnknownSync(RunRecord)(await response.json());
  expect(record.status).toBe("exited");
  expect(record.output?.exitCode).toBe(0);
  expect(record.output?.stdout).toBe("WASI before suspension\nWASI after suspension\n");
  expect(record.output?.stderr).toBe("WASI error stream\n");
});
