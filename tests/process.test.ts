import { afterAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Schema } from "effect";
import {
  ErrorResponse,
  FileContent,
  ProcessPage,
  RunRecord,
  TokenResponse,
} from "../src/contracts";
import { runtime } from "../tooling/runtime";

const directory = await mkdtemp(join(tmpdir(), "cirro-process-"));
const origin = `export default { async fetch(request) {
  await new Promise(resolve => setTimeout(resolve, 500));
  return new Response("native deferred response");
} };`;
const mf = runtime(directory, origin);
const post = async (path: string, token: string, body: unknown, signal?: AbortSignal) =>
  fetch(new URL(path, await mf.ready), {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });
const action = (id: string, token: string, body: unknown, signal?: AbortSignal) =>
  post(`/v1/sandboxes/${id}/action`, token, body, signal);
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

test("spawn executes every existing runtime and reserves duplicate IDs exactly once", async () => {
  const token = await setup("spawn-runtimes");
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
    const response = await action("spawn-runtimes", token, {
      op: "process.spawn",
      execution: { op: "process.run", id: language, language, source },
    });
    expect(response.status).toBe(200);
    const reserved = Schema.decodeUnknownSync(RunRecord)(await response.json());
    expect(reserved.status).toBe("running");
    expect(reserved.output).toBeNull();
    const finished = await observed("spawn-runtimes", token, language);
    expect(finished.output?.exitCode).toBe(0);
    expect(language).toBe(finished.language);
  }
  const attempts = await Promise.all(
    Array.from({ length: 4 }, () =>
      action("spawn-runtimes", token, {
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
  expect((await observed("spawn-runtimes", token, "once")).output?.result).toBe(42);
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
        source:
          'export default async ({tools}) => await tools.call({op:"process.spawn",execution:{op:"process.run",id:"escape",language:"shell",source:"true"}})',
      })
    ).json(),
  );
  expect(rejected.output?.exitCode).not.toBe(0);
  expect((await action("spawn-tools", token, { op: "process.get", id: "escape" })).status).toBe(
    404,
  );
});

test("background execution settles its wall-time limit before the Worker continuation expires", async () => {
  const token = await setup("spawn-wall-limit");
  expect(
    (
      await action("spawn-wall-limit", token, {
        op: "process.spawn",
        execution: {
          op: "process.run",
          id: "long",
          language: "javascript",
          source:
            'export default async ({tools}) => { for (const value of Array.from({length:100})) await tools.call({op:"network.fetch",url:"https://allowed.example/slow"}); return 42; }',
        },
      })
    ).status,
  ).toBe(200);
  const initial = await action("spawn-wall-limit", token, {
    op: "process.wait",
    id: "long",
    timeoutMs: 25_000,
  });
  expect([408, 500]).toContain(initial.status);
  const settled = await action("spawn-wall-limit", token, {
    op: "process.wait",
    id: "long",
    timeoutMs: 5000,
  });
  expect(settled.status).toBe(500);
  expect(Schema.decodeUnknownSync(ErrorResponse)(await settled.json()).error).toBe(
    "EXECUTION_FAILED",
  );
  const record = Schema.decodeUnknownSync(RunRecord)(
    await (await action("spawn-wall-limit", token, { op: "process.get", id: "long" })).json(),
  );
  expect(record.status).toBe("failed");
  expect(record.output).toBeNull();
}, 35_000);

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
  const first = runtime(persisted);
  const send = async (
    instance: ReturnType<typeof runtime>,
    token: string,
    path: string,
    body: unknown,
  ) =>
    fetch(new URL(path, await instance.ready), {
      method: "POST",
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
  const second = runtime(persisted);
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
