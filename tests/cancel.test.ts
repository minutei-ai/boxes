import { afterAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Schema } from "effect";
import { ErrorResponse, FileContent, RunRecord, RunSummary, TokenResponse } from "../src/contracts";
import { runtime } from "../tooling/worker-test";

const directory = await mkdtemp(join(tmpdir(), "cirro-cancel-"));
const mf = runtime(directory, {
  consume: true,
  controlled: false,
  origin: { delay: 2000, body: "native delay" },
});
const post = async (
  instance: ReturnType<typeof runtime>,
  path: string,
  token: string,
  body: unknown,
) =>
  fetch(new URL(path, await instance.ready), {
    method: "POST",
    keepalive: false,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
const act = (id: string, token: string, body: unknown) =>
  post(mf, `/v1/sandboxes/${id}/action`, token, body);
const setup = async (instance: ReturnType<typeof runtime>, id: string) => {
  expect(
    (
      await post(instance, "/v1/sandboxes", "cirro-local-test-credential", {
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
      await post(instance, `/v1/sandboxes/${id}/capabilities`, "cirro-local-test-credential", {
        permissions: ["read", "write", "execute", "network", "manage"],
        expiresInSeconds: 3600,
      })
    ).json(),
  ).token;
};
const running = async (id: string, token: string) => {
  for (const attempt of Array.from({ length: 50 }, (_, index) => index)) {
    const record = Schema.decodeUnknownSync(RunRecord)(
      await (await act(id, token, { op: "process.get", id: "work" })).json(),
    );
    if (record.status === "running") return record;
    await Bun.sleep(20);
    expect(attempt).toBeLessThan(49);
  }
  return Promise.reject(new Error("Execution was not observed running"));
};
afterAll(async () => {
  await mf.dispose();
  await rm(directory, { recursive: true, force: true });
});

test("JavaScript, TypeScript and Python stop before later mutations while preserving confirmed effects", async () => {
  const sources = {
    javascript:
      'export default async ({tools}) => { await tools.call({op:"filesystem.writeFile",path:"/tmp/before",content:"confirmed",encoding:"utf8"}); for (const value of [1,2,3]) await tools.call({op:"network.fetch",url:"https://allowed.example/delay"}); await tools.call({op:"filesystem.writeFile",path:"/tmp/after",content:"late",encoding:"utf8"}); return 42; }',
    typescript:
      'export default async ({tools}): Promise<number> => { await tools.call({op:"filesystem.writeFile",path:"/tmp/before",content:"confirmed",encoding:"utf8"}); for (const value of [1,2,3]) await tools.call({op:"network.fetch",url:"https://allowed.example/delay"}); await tools.call({op:"filesystem.writeFile",path:"/tmp/after",content:"late",encoding:"utf8"}); return 42; }',
    python:
      'await tools.call({"op":"filesystem.writeFile","path":"/tmp/before","content":"confirmed","encoding":"utf8"})\nfor value in [1,2,3]:\n await tools.call({"op":"network.fetch","url":"https://allowed.example/delay"})\nawait tools.call({"op":"filesystem.writeFile","path":"/tmp/after","content":"late","encoding":"utf8"})\n42',
  };
  for (const [language, source] of Object.entries(sources)) {
    const id = `cancel-${language}`;
    const token = await setup(mf, id);
    expect(
      (
        await act(id, token, {
          op: "process.spawn",
          execution: { op: "process.run", id: "work", language, source },
        })
      ).status,
    ).toBe(200);
    await running(id, token);
    for (const attempt of Array.from({ length: 50 }, (_, index) => index)) {
      const before = await act(id, token, { op: "filesystem.readFile", path: "/tmp/before" });
      if (before.status === 200) break;
      await Bun.sleep(20);
      expect(attempt).toBeLessThan(49);
    }
    const request = await act(id, token, { op: "process.cancel", id: "work" });
    expect(request.status).toBe(200);
    const summary = Schema.decodeUnknownSync(RunSummary)(await request.json());
    expect(summary.status).toBe("cancelling");
    expect(summary.finishedAt).toBeNull();
    const waited = await act(id, token, { op: "process.wait", id: "work", timeoutMs: 10_000 });
    expect(waited.status).toBe(409);
    expect(Schema.decodeUnknownSync(ErrorResponse)(await waited.json()).error).toBe("ECANCELED");
    const record = Schema.decodeUnknownSync(RunRecord)(
      await (await act(id, token, { op: "process.get", id: "work" })).json(),
    );
    expect(record.status).toBe("cancelled");
    expect(record.finishedAt).not.toBeNull();
    expect(record.output).toBeNull();
    expect((await act(id, token, { op: "filesystem.readFile", path: "/tmp/after" })).status).toBe(
      404,
    );
    const preserved = Schema.decodeUnknownSync(FileContent)(
      await (await act(id, token, { op: "filesystem.readFile", path: "/tmp/before" })).json(),
    );
    expect(Buffer.from(preserved.content, "base64").toString()).toBe("confirmed");
  }
}, 15_000);

test("WASI and shell release a pending native clock wait on cancellation", async () => {
  const source = Buffer.from(
    await Bun.file(join(import.meta.dir, "../dist/wasi-background.wasm")).arrayBuffer(),
  ).toString("base64");
  for (const language of ["wasm", "shell"] as const) {
    const id = `cancel-${language}`;
    const token = await setup(mf, id);
    if (language === "shell") {
      expect(
        (
          await act(id, token, {
            op: "filesystem.writeFile",
            path: "/tmp/sleep",
            content: source,
            encoding: "base64",
          })
        ).status,
      ).toBe(200);
      expect(
        (await act(id, token, { op: "filesystem.chmod", path: "/tmp/sleep", mode: 493 })).status,
      ).toBe(200);
    }
    const program = {
      wasm: source,
      shell: "echo staged > /tmp/staged; /tmp/sleep; echo after > /tmp/after",
    };
    const response = await act(id, token, {
      op: "process.spawn",
      execution: { op: "process.run", id: "work", language, source: program[language] },
    });
    expect(response.status).toBe(200);
    await running(id, token);
    expect((await act(id, token, { op: "process.cancel", id: "work" })).status).toBe(200);
    expect(
      (await act(id, token, { op: "process.wait", id: "work", timeoutMs: 10_000 })).status,
    ).toBe(409);
    const record = Schema.decodeUnknownSync(RunRecord)(
      await (await act(id, token, { op: "process.get", id: "work" })).json(),
    );
    expect(record.status).toBe("cancelled");
    expect(record.output).toBeNull();
    expect((await act(id, token, { op: "filesystem.readFile", path: "/tmp/staged" })).status).toBe(
      404,
    );
    expect((await act(id, token, { op: "filesystem.readFile", path: "/tmp/after" })).status).toBe(
      404,
    );
  }
});

test("queued cancellation is durable, idempotent and cannot expose output to an execute-only caller", async () => {
  const persisted = await mkdtemp(join(tmpdir(), "cirro-cancel-queued-"));
  const first = runtime(persisted, { consume: false, controlled: false });
  const id = "cancel-queued";
  const token = await setup(first, id);
  const path = `/v1/sandboxes/${id}/action`;
  const accepted = await post(first, path, token, {
    op: "process.spawn",
    execution: {
      op: "process.run",
      id: "work",
      language: "javascript",
      source: "export default () => 42;",
    },
  });
  expect([200, 500]).toContain(accepted.status);
  const stopped = Schema.decodeUnknownSync(RunSummary)(
    await (await post(first, path, token, { op: "process.cancel", id: "work" })).json(),
  );
  expect(stopped.status).toBe("cancelled");
  expect(
    Schema.decodeUnknownSync(RunSummary)(
      await (await post(first, path, token, { op: "process.cancel", id: "work" })).json(),
    ),
  ).toEqual(stopped);
  await first.dispose();
  const second = runtime(persisted, { consume: true, controlled: false });
  expect(
    (await post(second, "/v1/maintenance/process-dispatch", "cirro-local-test-credential", {}))
      .status,
  ).toBe(200);
  const restored = Schema.decodeUnknownSync(RunRecord)(
    await (await post(second, path, token, { op: "process.get", id: "work" })).json(),
  );
  expect(restored.status).toBe("cancelled");
  expect(restored.output).toBeNull();
  const completed = await post(second, path, token, {
    op: "process.run",
    id: "completed",
    language: "javascript",
    source: 'export default () => "private output";',
  });
  expect(completed.status).toBe(200);
  const minted = await post(
    second,
    `/v1/sandboxes/${id}/capabilities`,
    "cirro-local-test-credential",
    { permissions: ["execute"], expiresInSeconds: 3600 },
  );
  const executeOnly = Schema.decodeUnknownSync(TokenResponse)(await minted.json()).token;
  const response = await post(second, path, executeOnly, { op: "process.cancel", id: "completed" });
  expect(response.status).toBe(200);
  const json = Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.Unknown))(
    await response.json(),
  );
  expect(Object.keys(json)).not.toContain("output");
  expect(Object.keys(json)).not.toContain("authority");
  expect(
    (await post(second, path, executeOnly, { op: "process.get", id: "completed" })).status,
  ).toBe(403);
  await second.dispose();
  await rm(persisted, { recursive: true, force: true });
});

test("cancellation requires execute permission and retains sandbox isolation", async () => {
  const id = "cancel-grants";
  const token = await setup(mf, id);
  const readOnly = Schema.decodeUnknownSync(TokenResponse)(
    await (
      await post(mf, `/v1/sandboxes/${id}/capabilities`, "cirro-local-test-credential", {
        permissions: ["read"],
        expiresInSeconds: 3600,
      })
    ).json(),
  ).token;
  expect((await act(id, readOnly, { op: "process.cancel", id: "missing" })).status).toBe(403);
  expect((await act(id, token, { op: "process.cancel", id: "missing" })).status).toBe(404);
  const other = await setup(mf, "cancel-other");
  expect((await act("cancel-other", token, { op: "process.cancel", id: "work" })).status).toBe(401);
  expect((await act("cancel-other", other, { op: "process.cancel", id: "work" })).status).toBe(404);
});

test("natural completion racing cancellation never leaves synchronous processes stuck cancelling", async () => {
  const id = "cancel-race";
  const token = await setup(mf, id);
  await Promise.all(
    Array.from({ length: 8 }, async (_, index) => {
      const runId = `race-${index}`;
      const executing = act(id, token, {
        op: "process.run",
        id: runId,
        language: "javascript",
        source: "export default () => 42;",
      });
      await Bun.sleep(index * 2);
      const stopped = await act(id, token, { op: "process.cancel", id: runId });
      expect([200, 404, 409]).toContain(stopped.status);
      await executing;
      const observed = await act(id, token, { op: "process.wait", id: runId, timeoutMs: 3000 });
      expect([200, 409]).toContain(observed.status);
      const record = Schema.decodeUnknownSync(RunRecord)(
        await (await act(id, token, { op: "process.get", id: runId })).json(),
      );
      expect(["exited", "cancelled"]).toContain(record.status);
      if (record.status === "exited") expect(record.output?.result).toBe(42);
      else expect(record.output).toBeNull();
    }),
  );
});

test("scoped guest tools can request cancellation and preserve full process wait output", async () => {
  const id = "cancel-tools";
  const token = await setup(mf, id);
  const source = Buffer.from(
    await Bun.file(join(import.meta.dir, "../dist/wasi-background.wasm")).arrayBuffer(),
  ).toString("base64");
  expect(
    (
      await act(id, token, {
        op: "process.spawn",
        execution: { op: "process.run", id: "work", language: "wasm", source },
      })
    ).status,
  ).toBe(200);
  await running(id, token);
  const response = await act(id, token, {
    op: "python.evaluate",
    id: "controller",
    expression: '(await tools.call({"op":"process.cancel","id":"work"}))["status"]',
  });
  const controller = Schema.decodeUnknownSync(RunRecord)(await response.json());
  expect(controller.output?.exitCode).toBe(0);
  expect(controller.output?.result).toBe("cancelling");
  expect((await act(id, token, { op: "process.wait", id: "work", timeoutMs: 5000 })).status).toBe(
    409,
  );
  const marker = Schema.decodeUnknownSync(RunRecord)(
    await (await act(id, token, { op: "process.get", id: "work" })).json(),
  );
  expect(marker.status).toBe("cancelled");
});
