import { afterAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Schema, Struct } from "effect";
import {
  ErrorResponse,
  FileContent,
  ProcessPage,
  RunRecord,
  StoredRun,
  StoredRunMetadata,
  ProcessDelivery,
  TokenResponse,
} from "../src/contracts";
import { runtime } from "../tooling/worker-test";

const directory = await mkdtemp(join(tmpdir(), "cirro-process-"));
const mf = runtime(directory, {
  consume: true,
  controlled: false,
  origin: { delay: 500, body: "native deferred response" },
});
const post = async (path: string, token: string, body: unknown, signal?: AbortSignal) =>
  fetch(new URL(path, await mf.ready), {
    method: "POST",
    keepalive: false,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });
const action = async (id: string, token: string, body: unknown, signal?: AbortSignal) => {
  const response = await post(`/v1/sandboxes/${id}/action`, token, body, signal);
  return response;
};
const mint = async (id: string, permissions: string[], expiresInSeconds = 3600) =>
  Schema.decodeUnknownSync(TokenResponse)(
    await (
      await post(`/v1/sandboxes/${id}/capabilities`, "cirro-local-test-credential", {
        permissions,
        expiresInSeconds,
      })
    ).json(),
  ).token;
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
  return mint(id, ["read", "write", "execute", "network", "manage"]);
};
const deferredSource =
  'export default async ({tools}) => { await tools.call({op:"network.fetch",url:"https://allowed.example/slow"}); await tools.call({op:"filesystem.writeFile",path:"/tmp/background",content:"persisted after disconnect",encoding:"utf8"}); return 42; }';
const observed = async (sandbox: string, token: string, id: string) => {
  const response = await action(sandbox, token, { op: "process.wait", id, timeoutMs: 10_000 });
  expect(response.status).toBe(200);
  return Schema.decodeUnknownSync(RunRecord)(await response.json());
};
afterAll(async () => {
  await mf.dispose();
  await rm(directory, { recursive: true, force: true });
});

test("spawn survives the initiating request and wait reports a real exit after an observation timeout", async () => {
  const token = await setup("detached");
  const controller = new AbortController();
  const started = await action(
    "detached",
    token,
    {
      op: "process.spawn",
      execution: {
        op: "process.run",
        id: "background",
        language: "javascript",
        source: deferredSource,
      },
    },
    controller.signal,
  );
  expect(started.status).toBe(200);
  await started.body?.cancel();
  controller.abort();
  const early = await action("detached", token, {
    op: "process.wait",
    id: "background",
    timeoutMs: 0,
  });
  expect(early.status).toBe(408);
  expect(Schema.decodeUnknownSync(ErrorResponse)(await early.json()).error).toBe("ETIMEDOUT");
  const running = Schema.decodeUnknownSync(RunRecord)(
    await (await action("detached", token, { op: "process.get", id: "background" })).json(),
  );
  expect(running.status).toBe("running");
  expect(running.finishedAt).toBeNull();
  const completed = await observed("detached", token, "background");
  expect(completed.status).toBe("exited");
  expect(completed.output?.exitCode).toBe(0);
  expect(completed.output?.result).toBe(42);
  const file = Schema.decodeUnknownSync(FileContent)(
    await (
      await action("detached", token, { op: "filesystem.readFile", path: "/tmp/background" })
    ).json(),
  );
  expect(Buffer.from(file.content, "base64").toString()).toBe("persisted after disconnect");
  const repeated = Schema.decodeUnknownSync(RunRecord)(
    await (
      await action("detached", token, { op: "process.wait", id: "background", timeoutMs: 0 })
    ).json(),
  );
  expect(repeated).toEqual(completed);
});

const programs = {
  javascript: "export default () => 42;",
  typescript: "export default (): number => 42;",
  python: "6 * 7",
  shell: "echo native-background",
  wasm: Buffer.from(
    await Bun.file(join(import.meta.dir, "../dist/guest-test.wasm")).arrayBuffer(),
  ).toString("base64"),
};
for (const [language, source] of Object.entries(programs)) {
  test(`spawn executes the ${language} runtime through the native Queue`, async () => {
    const sandbox = `spawn-${language}`;
    const token = await setup(sandbox);
    const response = await action(sandbox, token, {
      op: "process.spawn",
      execution: { op: "process.run", id: language, language, source },
    });
    expect(response.status).toBe(200);
    const reserved = Schema.decodeUnknownSync(RunRecord)(await response.json());
    expect(reserved.status).toBe("queued");
    expect(reserved.output).toBeNull();
    const finished = await observed(sandbox, token, language);
    expect(finished.status).toBe("exited");
    expect(finished.output?.exitCode).toBe(0);
    expect(language).toBe(finished.language);
  });
}
test("concurrent spawn reserves duplicate IDs exactly once", async () => {
  const token = await setup("spawn-reservation");
  const attempts = await Promise.all(
    Array.from({ length: 4 }, () =>
      action("spawn-reservation", token, {
        op: "process.spawn",
        execution: {
          op: "process.run",
          id: "once",
          language: "javascript",
          source: deferredSource,
        },
      }),
    ),
  );
  expect(attempts.filter((response) => response.status === 200)).toHaveLength(1);
  expect(attempts.filter((response) => response.status === 409)).toHaveLength(3);
  expect((await observed("spawn-reservation", token, "once")).output?.result).toBe(42);
});

test("file entry preparation, permissions and sandbox isolation remain authoritative for spawn and wait", async () => {
  const token = await setup("spawn-grants");
  const readOnly = await mint("spawn-grants", ["read"]);
  expect(
    (
      await action("spawn-grants", readOnly, {
        op: "process.spawn",
        execution: {
          op: "process.run",
          id: "denied",
          language: "javascript",
          source: "export default () => 1;",
        },
      })
    ).status,
  ).toBe(403);
  expect((await action("spawn-grants", token, { op: "process.get", id: "denied" })).status).toBe(
    404,
  );
  expect(
    (
      await action("spawn-grants", token, {
        op: "process.spawn",
        execution: { op: "javascript.executeFile", id: "missing", path: "/tmp/not-present.js" },
      })
    ).status,
  ).toBe(404);
  expect((await action("spawn-grants", token, { op: "process.get", id: "missing" })).status).toBe(
    404,
  );
  expect(
    (
      await action("spawn-grants", token, {
        op: "filesystem.writeFile",
        path: "/tmp/entry.py",
        encoding: "utf8",
        content: "6 * 7",
      })
    ).status,
  ).toBe(200);
  expect(
    (
      await action("spawn-grants", token, {
        op: "process.spawn",
        execution: { op: "python.executeFile", id: "file", path: "/tmp/entry.py" },
      })
    ).status,
  ).toBe(200);
  expect((await observed("spawn-grants", token, "file")).output?.result).toBe(42);
  expect(
    (await action("spawn-grants", readOnly, { op: "process.wait", id: "file", timeoutMs: 0 }))
      .status,
  ).toBe(200);
  const executeOnly = await mint("spawn-grants", ["execute"]);
  expect(
    (await action("spawn-grants", executeOnly, { op: "process.wait", id: "file", timeoutMs: 0 }))
      .status,
  ).toBe(403);
  const other = await setup("spawn-other");
  expect(
    (await action("spawn-other", other, { op: "process.wait", id: "file", timeoutMs: 0 })).status,
  ).toBe(404);
  expect(
    (await action("spawn-other", token, { op: "process.wait", id: "file", timeoutMs: 0 })).status,
  ).toBe(401);
  const page = Schema.decodeUnknownSync(ProcessPage)(
    await (
      await action("spawn-grants", token, { op: "process.list", limit: 10, cursor: null })
    ).json(),
  );
  expect(page.items.map((item) => item.id)).toEqual(["file"]);
});

test("wait rejects lost guest exits and never fabricates an exit code", async () => {
  const token = await setup("spawn-failure");
  expect(
    (
      await action("spawn-failure", token, {
        op: "process.spawn",
        execution: {
          op: "process.run",
          id: "fuel",
          language: "javascript",
          source: "export default () => { while (true) {} };",
        },
      })
    ).status,
  ).toBe(200);
  const response = await action("spawn-failure", token, {
    op: "process.wait",
    id: "fuel",
    timeoutMs: 10_000,
  });
  expect(response.status).toBe(500);
  expect(Schema.decodeUnknownSync(ErrorResponse)(await response.json()).error).toBe(
    "EXECUTION_FAILED",
  );
  const failed = Schema.decodeUnknownSync(RunRecord)(
    await (await action("spawn-failure", token, { op: "process.get", id: "fuel" })).json(),
  );
  expect(failed.status).toBe("failed");
  expect(failed.output).toBeNull();
  expect(failed.finishedAt).not.toBeNull();
  expect(
    (await action("spawn-failure", token, { op: "process.wait", id: "unknown", timeoutMs: 0 }))
      .status,
  ).toBe(404);
});

test("guest tools can wait on a background process without acquiring host lifecycle authority", async () => {
  const token = await setup("spawn-tools");
  expect(
    (
      await action("spawn-tools", token, {
        op: "process.spawn",
        execution: {
          op: "process.run",
          id: "child",
          language: "javascript",
          source: deferredSource,
        },
      })
    ).status,
  ).toBe(200);
  const response = await action("spawn-tools", token, {
    op: "process.run",
    id: "observer",
    language: "python",
    source:
      '(await tools.call({"op":"process.wait","id":"child","timeoutMs":10000}))["output"]["result"]',
  });
  const record = Schema.decodeUnknownSync(RunRecord)(await response.json());
  expect(record.output?.exitCode).toBe(0);
  expect(record.output?.result).toBe(42);
  const rejected = Schema.decodeUnknownSync(RunRecord)(
    await (
      await action("spawn-tools", token, {
        op: "process.run",
        id: "not-authorized",
        language: "javascript",
        source: 'export default async ({tools}) => await tools.call({op:"vm.dispose"})',
      })
    ).json(),
  );
  expect(rejected.output?.exitCode).not.toBe(0);
  expect((await action("spawn-tools", token, { op: "process.get", id: "escape" })).status).toBe(
    404,
  );
});

test("queue execution survives beyond the former 25-second continuation budget", async () => {
  const directory = await mkdtemp(join(tmpdir(), "boxes-continuation-clock-"));
  const instance = runtime(directory, { advance: 30_000 });
  const send = async (
    path: string,
    token: string,
    body: unknown,
    headers: Record<string, string> = {},
  ) =>
    fetch(new URL(path, await instance.ready), {
      method: "POST",
      keepalive: false,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    });
  const path = "/v1/sandboxes/spawn-wall-limit/action";
  expect(
    (
      await send("/v1/sandboxes", "cirro-local-test-credential", {
        id: "spawn-wall-limit",
        policy: {
          networkHosts: [],
          interruptBudget: 1000,
          memoryBytes: 8388608,
          maxOutputBytes: 1048576,
        },
      })
    ).status,
  ).toBe(201);
  const token = Schema.decodeUnknownSync(TokenResponse)(
    await (
      await send("/v1/sandboxes/spawn-wall-limit/capabilities", "cirro-local-test-credential", {
        permissions: ["read", "write", "execute"],
        expiresInSeconds: 3600,
      })
    ).json(),
  ).token;
  const source = Buffer.from(
    await Bun.file(join(import.meta.dir, "../dist/wasi-background-ready.wasm")).arrayBuffer(),
  ).toString("base64");
  expect(
    (
      await send(path, token, {
        op: "process.spawn",
        execution: { op: "process.run", id: "long", language: "wasm", source },
      })
    ).status,
  ).toBe(200);
  expect(
    (
      await send(
        path,
        token,
        { op: "process.wait", id: "long", timeoutMs: 25_000 },
        { "x-boxes-test-clock-advance": "25000" },
      )
    ).status,
  ).toBe(408);
  const objects = await instance.objects;
  const key = "processes/spawn-wall-limit/long.json";
  const retained = await objects.head(key);
  if (retained === null) return expect(retained).not.toBeNull();
  const worker = await instance.control;
  await worker.deliver("executions", [
    {
      id: "long",
      timestamp: new Date(),
      attempts: 1,
      body: Schema.encodeSync(ProcessDelivery)({ key, eTag: retained.etag }),
    },
  ]);
  const paused = Schema.decodeUnknownSync(RunRecord)(
    await (await send(path, token, { op: "process.get", id: "long" })).json(),
  );
  expect(paused.status).toBe("queued");
  const published = await objects.get(key);
  if (published === null) return expect(published).not.toBeNull();
  expect(
    Schema.decodeUnknownSync(Schema.fromJsonString(StoredRun))(await published.text())
      .checkpointCount,
  ).toBe(1);
  await instance.dispose();
  const resumed = runtime(directory, { clockStart: instance.time, advance: 1000 });
  const retainedAfter = await (await resumed.objects).head(key);
  if (retainedAfter === null) return expect(retainedAfter).not.toBeNull();
  const second = await resumed.control;
  await second.deliver("executions", [
    {
      id: "resume",
      timestamp: new Date(),
      attempts: 1,
      body: Schema.encodeSync(ProcessDelivery)({ key, eTag: retainedAfter.etag }),
    },
  ]);
  const final = await fetch(new URL(path, await resumed.ready), {
    method: "POST",
    keepalive: false,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ op: "process.wait", id: "long", timeoutMs: 10_000 }),
  });
  expect(final.status).toBe(200);
  const record = Schema.decodeUnknownSync(RunRecord)(await final.json());
  expect(record.status).toBe("exited");
  expect(record.output?.exitCode).toBe(0);
  expect(record.finishedAt).toBe(resumed.time);
  expect(record.output?.stdout).toBe(
    "continuation entered\ncontinued beyond the HTTP continuation\n",
  );
  await resumed.dispose();
  await rm(directory, { recursive: true, force: true });
});

test("wait enforces capability expiry while another authorized caller keeps the execution", async () => {
  const token = await setup("wait-expiry");
  expect(
    (
      await action("wait-expiry", token, {
        op: "process.spawn",
        execution: {
          op: "process.run",
          id: "slow",
          language: "javascript",
          source:
            'export default async ({tools}) => { for (const value of [1,2,3,4,5]) await tools.call({op:"network.fetch",url:"https://allowed.example/slow"}); return 42; }',
        },
      })
    ).status,
  ).toBe(200);
  const short = await mint("wait-expiry", ["read"], 1);
  const expired = await action("wait-expiry", short, {
    op: "process.wait",
    id: "slow",
    timeoutMs: 10_000,
  });
  expect(expired.status).toBe(401);
  expect(Schema.decodeUnknownSync(ErrorResponse)(await expired.json()).error).toBe("UNAUTHORIZED");
  expect((await observed("wait-expiry", token, "slow")).output?.result).toBe(42);
});

test("completed background receipts survive replacing the Worker without replaying the execution", async () => {
  const persisted = await mkdtemp(join(tmpdir(), "cirro-process-restart-"));
  const first = runtime(persisted, { consume: true, controlled: false });
  const send = async (
    instance: ReturnType<typeof runtime>,
    token: string,
    path: string,
    body: unknown,
  ) =>
    fetch(new URL(path, await instance.ready), {
      method: "POST",
      keepalive: false,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  const id = "retained-background";
  expect(
    (
      await send(first, "cirro-local-test-credential", "/v1/sandboxes", {
        id,
        policy: {
          networkHosts: [],
          interruptBudget: 1000,
          memoryBytes: 8_388_608,
          maxOutputBytes: 1_048_576,
        },
      })
    ).status,
  ).toBe(201);
  const token = Schema.decodeUnknownSync(TokenResponse)(
    await (
      await send(first, "cirro-local-test-credential", `/v1/sandboxes/${id}/capabilities`, {
        permissions: ["read", "execute"],
        expiresInSeconds: 3600,
      })
    ).json(),
  ).token;
  expect(
    (
      await send(first, token, `/v1/sandboxes/${id}/action`, {
        op: "process.spawn",
        execution: {
          op: "process.run",
          id: "retained",
          language: "javascript",
          source: "export default () => 42;",
        },
      })
    ).status,
  ).toBe(200);
  const original = Schema.decodeUnknownSync(RunRecord)(
    await (
      await send(first, token, `/v1/sandboxes/${id}/action`, {
        op: "process.wait",
        id: "retained",
        timeoutMs: 10_000,
      })
    ).json(),
  );
  expect(original.output?.result).toBe(42);
  await first.dispose();
  const second = runtime(persisted, { consume: true, controlled: false });
  const restored = Schema.decodeUnknownSync(RunRecord)(
    await (
      await send(second, token, `/v1/sandboxes/${id}/action`, {
        op: "process.wait",
        id: "retained",
        timeoutMs: 0,
      })
    ).json(),
  );
  expect(restored).toEqual(original);
  expect(
    (
      await send(second, token, `/v1/sandboxes/${id}/action`, {
        op: "process.spawn",
        execution: { op: "process.run", id: "retained", language: "shell", source: "false" },
      })
    ).status,
  ).toBe(409);
  await second.dispose();
  await rm(persisted, { recursive: true, force: true });
});

test("wait distinguishes observed nonzero exits from unobserved runtime failures and validates Wasm before reservation", async () => {
  const token = await setup("observed-exit");
  expect(
    (
      await action("observed-exit", token, {
        op: "process.spawn",
        execution: { op: "process.run", id: "nonzero", language: "shell", source: "false" },
      })
    ).status,
  ).toBe(200);
  const exited = await observed("observed-exit", token, "nonzero");
  expect(exited.status).toBe("exited");
  expect(exited.output?.exitCode).toBe(1);
  for (const source of ["AB==", "AAA", "AA!="]) {
    expect(
      (
        await action("observed-exit", token, {
          op: "process.spawn",
          execution: { op: "process.run", id: "invalid", language: "wasm", source },
        })
      ).status,
    ).toBe(400);
    expect(
      (await action("observed-exit", token, { op: "process.get", id: "invalid" })).status,
    ).toBe(404);
  }
});

test("duplicate native Queue deliveries enter the execution only once", async () => {
  const token = await setup("queue-duplicate");
  const originWorker = await mf.origin();
  const before = await (await fetch(new URL("/count", originWorker))).json();
  const response = await post("/v1/sandboxes/queue-duplicate/action", token, {
    op: "process.spawn",
    execution: { op: "process.run", id: "once", language: "javascript", source: deferredSource },
  });
  expect(response.status).toBe(200);
  const bucket = await mf.objects;
  const object = await bucket.head("processes/queue-duplicate/once.json");
  if (object === null) return expect(object).not.toBeNull();
  const worker = await mf.control;
  const body = Schema.encodeSync(ProcessDelivery)({ key: object.key, eTag: object.etag });
  await worker.notify(Array.from({ length: 4 }, () => ({ body })));
  expect((await observed("queue-duplicate", token, "once")).output?.result).toBe(42);
  const after = Schema.decodeUnknownSync(Schema.Number)(
    await (await fetch(new URL("/count", originWorker))).json(),
  );
  expect(after - Schema.decodeUnknownSync(Schema.Number)(before)).toBe(1);
  const publicRecord = await (
    await action("queue-duplicate", token, { op: "process.get", id: "once" })
  ).json();
  expect(
    Object.keys(
      Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.Unknown))(publicRecord),
    ),
  ).not.toContain("authority");
});

test("claimed execution with a lost observation becomes failed after its platform deadline without replay", async () => {
  const token = await setup("queue-lost");
  expect(
    (
      await action("queue-lost", token, {
        op: "process.run",
        id: "lost",
        language: "javascript",
        source: "export default () => 42;",
      })
    ).status,
  ).toBe(200);
  const bucket = await mf.objects;
  const object = await bucket.get("processes/queue-lost/lost.json");
  if (object === null) return expect(object).not.toBeNull();
  const stored = Schema.decodeUnknownSync(Schema.fromJsonString(StoredRun))(await object.text());
  const lost = {
    ...stored,
    status: "running" as const,
    authority: null,
    deadlineAt: Date.now() - 1,
    output: null,
    finishedAt: null,
  };
  await bucket.put(object.key, Schema.encodeSync(Schema.fromJsonString(StoredRun))(lost), {
    customMetadata: Schema.encodeSync(StoredRunMetadata)({
      format: "run-v5",
      summary: Struct.omit(lost, ["authority", "deadlineAt", "output", "stdinMode", "checkpoint"]),
    }),
  });
  const retained = await bucket.head("processes/queue-lost/lost.json");
  if (retained === null) return expect(retained).not.toBeNull();
  const worker = await mf.control;
  await worker.notify([
    { body: Schema.encodeSync(ProcessDelivery)({ key: retained.key, eTag: retained.etag }) },
  ]);
  const waited = await action("queue-lost", token, {
    op: "process.wait",
    id: "lost",
    timeoutMs: 10_000,
  });
  expect(waited.status).toBe(500);
  const record = Schema.decodeUnknownSync(RunRecord)(
    await (await action("queue-lost", token, { op: "process.get", id: "lost" })).json(),
  );
  expect(record.status).toBe("failed");
  expect(record.output).toBeNull();
  expect(
    (await action("queue-lost", token, { op: "filesystem.exists", path: "/tmp/background" }))
      .status,
  ).toBe(200);
  const file = await action("queue-lost", token, {
    op: "filesystem.readFile",
    path: "/tmp/background",
  });
  expect(file.status).toBe(404);
});

test("queued work survives a stopped consumer and archived corruption settles before entry", async () => {
  const persisted = await mkdtemp(join(tmpdir(), "cirro-queue-repair-"));
  const first = runtime(persisted, { consume: false, controlled: false });
  const send = async (
    instance: ReturnType<typeof runtime>,
    token: string,
    path: string,
    body: unknown,
  ) =>
    fetch(new URL(path, await instance.ready), {
      method: "POST",
      keepalive: false,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  const id = "queue-repair";
  expect(
    (
      await send(first, "cirro-local-test-credential", "/v1/sandboxes", {
        id,
        policy: {
          networkHosts: [],
          interruptBudget: 1000,
          memoryBytes: 8_388_608,
          maxOutputBytes: 1_048_576,
        },
      })
    ).status,
  ).toBe(201);
  const token = Schema.decodeUnknownSync(TokenResponse)(
    await (
      await send(first, "cirro-local-test-credential", `/v1/sandboxes/${id}/capabilities`, {
        permissions: ["read", "execute"],
        expiresInSeconds: 3600,
      })
    ).json(),
  ).token;
  for (const runId of ["valid", "corrupt"]) {
    const accepted = await send(first, token, `/v1/sandboxes/${id}/action`, {
      op: "process.spawn",
      execution: {
        op: "process.run",
        id: runId,
        language: "javascript",
        source: `export default () => '${runId}';`,
      },
    });
    expect([200, 500]).toContain(accepted.status);
  }
  const queued = Schema.decodeUnknownSync(RunRecord)(
    await (
      await send(first, token, `/v1/sandboxes/${id}/action`, { op: "process.get", id: "corrupt" })
    ).json(),
  );
  expect(queued.status).toBe("queued");
  const bucket = await first.objects;
  await bucket.put(`sandboxes/${id}/code/${queued.sourceHash}`, "corrupt");
  await first.dispose();
  const second = runtime(persisted, { consume: true, controlled: false });
  expect((await send(second, token, "/v1/maintenance/process-dispatch", {})).status).toBe(401);
  expect(
    (await send(second, "cirro-local-test-credential", "/v1/maintenance/process-dispatch", {}))
      .status,
  ).toBe(200);
  const valid = await send(second, token, `/v1/sandboxes/${id}/action`, {
    op: "process.wait",
    id: "valid",
    timeoutMs: 10_000,
  });
  expect(valid.status).toBe(200);
  expect(Schema.decodeUnknownSync(RunRecord)(await valid.json()).output?.result).toBe("valid");
  expect(
    (
      await send(second, token, `/v1/sandboxes/${id}/action`, {
        op: "process.wait",
        id: "corrupt",
        timeoutMs: 10_000,
      })
    ).status,
  ).toBe(500);
  await second.dispose();
  await rm(persisted, { recursive: true, force: true });
});

test("guest spawn uses the same sandbox authority and native durable queue from JavaScript, TypeScript and Python", async () => {
  const token = await setup("guest-spawn");
  for (const language of ["javascript", "typescript", "python"] as const) {
    const child = {
      op: "process.run",
      id: `child-${language}`,
      language: "shell",
      source: "echo guest child",
    };
    const spawn = JSON.stringify({ op: "process.spawn", execution: child });
    const sources = {
      python: `(await tools.call(${spawn}))["id"]`,
      javascript: `export default async ({tools}) => (await tools.call(${spawn})).id`,
      typescript: `export default async ({tools}) => (await tools.call(${spawn})).id`,
    };
    const source = sources[language];
    const response = await action("guest-spawn", token, {
      op: "process.run",
      id: `parent-${language}`,
      language,
      source,
    });
    expect(response.status).toBe(200);
    const parent = Schema.decodeUnknownSync(RunRecord)(await response.json());
    expect(parent.output?.exitCode).toBe(0);
    expect(parent.output?.result).toBe(child.id);
    const record = await observed("guest-spawn", token, child.id);
    expect(record.output?.exitCode).toBe(0);
    expect(record.output?.stdout).toBe("guest child\n");
  }
  const limited = await mint("guest-spawn", ["execute"]);
  const response = await action("guest-spawn", limited, {
    op: "process.run",
    id: "limited-parent",
    language: "javascript",
    source:
      'export default async ({tools}) => { await tools.call({op:"process.spawn",execution:{op:"wasm.executeFile",id:"denied-child",path:"/tmp/private.wasm"}}); }',
  });
  const parent = Schema.decodeUnknownSync(RunRecord)(await response.json());
  expect(parent.output?.exitCode).not.toBe(0);
  expect(
    (await action("guest-spawn", token, { op: "process.get", id: "denied-child" })).status,
  ).toBe(404);
});
