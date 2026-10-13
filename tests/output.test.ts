import { afterAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Schema } from "effect";
import { ProcessOutputPage, RunRecord, TokenResponse } from "../src/contracts";
import { runtime } from "../tooling/runtime";

const directory = await mkdtemp(join(tmpdir(), "cirro-output-"));
const mf = runtime(directory);
const post = async (
  instance: ReturnType<typeof runtime>,
  path: string,
  token: string,
  body: unknown,
) =>
  fetch(new URL(path, await instance.ready), {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
const setup = async (instance: ReturnType<typeof runtime>, id: string) => {
  expect(
    (
      await post(instance, "/v1/sandboxes", "cirro-local-test-credential", {
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
  return Schema.decodeUnknownSync(TokenResponse)(
    await (
      await post(instance, `/v1/sandboxes/${id}/capabilities`, "cirro-local-test-credential", {
        permissions: ["read", "execute"],
        expiresInSeconds: 3600,
      })
    ).json(),
  ).token;
};
const act = (id: string, token: string, body: unknown) =>
  post(mf, `/v1/sandboxes/${id}/action`, token, body);
const read = async (
  id: string,
  token: string,
  runId: string,
  after: number | null,
  maxBytes = 65_536,
  maxEvents = 128,
) => {
  const response = await act(id, token, {
    op: "process.output.read",
    id: runId,
    after,
    maxBytes,
    maxEvents,
  });
  expect(response.status).toBe(200);
  return Schema.decodeUnknownSync(ProcessOutputPage)(await response.json());
};
afterAll(async () => {
  await mf.dispose();
  await rm(directory, { recursive: true, force: true });
});

test("replay preserves exact UTF-8 bytes, stream offsets and bounded event/byte pages", async () => {
  const token = await setup(mf, "output-bytes");
  const result = Schema.decodeUnknownSync(RunRecord)(
    await (
      await act("output-bytes", token, {
        op: "process.run",
        id: "printed",
        language: "javascript",
        source:
          'export default ({console}) => { console.log("😀\\u0000" + "Z".repeat(70000)); console.error("erroç".repeat(2000)); return 42; }',
      })
    ).json(),
  );
  const initial = await read("output-bytes", token, "printed", null, 3, 1);
  expect(initial.events).toHaveLength(1);
  expect(Buffer.from(initial.events[0]?.data ?? "", "base64")).toEqual(
    Buffer.from("😀").subarray(0, 3),
  );
  const second = await read("output-bytes", token, "printed", initial.nextCursor, 17, 1);
  expect(second.events).toHaveLength(1);
  expect(second.events[0]?.offset).toBe(3);
  expect(second.events[0]?.cursor).toBe(3);
  const stdout: Buffer[] = [
    Buffer.from(initial.events[0]?.data ?? "", "base64"),
    Buffer.from(second.events[0]?.data ?? "", "base64"),
  ];
  const stderr: Buffer[] = [];
  const progress = { cursor: second.nextCursor, more: second.hasMore };
  while (progress.more) {
    const page = await read("output-bytes", token, "printed", progress.cursor);
    expect(page.availability).toBe("retained");
    expect(page.truncated).toBe(false);
    expect(page.events.length).toBeLessThanOrEqual(128);
    expect(
      page.events.reduce((sum, event) => sum + Buffer.from(event.data, "base64").byteLength, 0),
    ).toBeLessThanOrEqual(65_536);
    for (const event of page.events) {
      expect(Buffer.from(event.data, "base64").byteLength).toBeLessThanOrEqual(4096);
      if (event.stream === "stdout") stdout.push(Buffer.from(event.data, "base64"));
      else stderr.push(Buffer.from(event.data, "base64"));
    }
    expect(page.nextCursor).toBeGreaterThan(progress.cursor);
    progress.cursor = page.nextCursor;
    progress.more = page.hasMore;
  }
  expect(Buffer.concat(stdout).toString()).toBe(result.output?.stdout);
  expect(Buffer.concat(stderr).toString()).toBe(result.output?.stderr);
  const eof = await read("output-bytes", token, "printed", progress.cursor);
  expect(eof.events).toEqual([]);
  expect(eof.nextCursor).toBe(progress.cursor);
  expect(eof.hasMore).toBe(false);
  expect(
    (
      await act("output-bytes", token, {
        op: "process.output.read",
        id: "printed",
        after: progress.cursor + 1,
        maxBytes: 16,
        maxEvents: 1,
      })
    ).status,
  ).toBe(400);
});

test("event limits resume within a stream and at the stdout/stderr boundary", async () => {
  const token = await setup(mf, "output-events");
  expect(
    (
      await act("output-events", token, {
        op: "process.run",
        id: "both",
        language: "javascript",
        source: 'export default ({console}) => { console.log("out"); console.error("err"); }',
      })
    ).status,
  ).toBe(200);
  const first = await read("output-events", token, "both", null, 65_536, 1);
  expect(first.events.map((event) => event.stream)).toEqual(["stdout"]);
  expect(first.nextCursor).toBe(4);
  expect(first.hasMore).toBe(true);
  const second = await read("output-events", token, "both", first.nextCursor, 65_536, 1);
  expect(second.events.map((event) => event.stream)).toEqual(["stderr"]);
  expect(second.events[0]?.offset).toBe(0);
  expect(second.events[0]?.cursor).toBe(4);
  expect(Buffer.from(second.events[0]?.data ?? "", "base64").toString()).toBe("err\n");
  expect(second.hasMore).toBe(false);
});

test("output authorization, unknown IDs and unsupported pagination inputs fail explicitly", async () => {
  const token = await setup(mf, "output-grants");
  expect(
    (
      await act("output-grants", token, {
        op: "process.run",
        id: "private",
        language: "shell",
        source: "echo private",
      })
    ).status,
  ).toBe(200);
  const executeOnly = Schema.decodeUnknownSync(TokenResponse)(
    await (
      await post(mf, "/v1/sandboxes/output-grants/capabilities", "cirro-local-test-credential", {
        permissions: ["execute"],
        expiresInSeconds: 3600,
      })
    ).json(),
  ).token;
  expect(
    (
      await act("output-grants", executeOnly, {
        op: "process.output.read",
        id: "private",
        after: null,
        maxBytes: 16,
        maxEvents: 1,
      })
    ).status,
  ).toBe(403);
  expect(
    (
      await act("output-grants", token, {
        op: "process.output.read",
        id: "unknown",
        after: null,
        maxBytes: 16,
        maxEvents: 1,
      })
    ).status,
  ).toBe(404);
  for (const fields of [
    { maxBytes: 0 },
    { maxBytes: 65_537 },
    { maxEvents: 0 },
    { maxEvents: 129 },
    { after: -1 },
    { filter: "stderr" },
  ])
    expect(
      (
        await act("output-grants", token, {
          op: "process.output.read",
          id: "private",
          after: null,
          maxBytes: 16,
          maxEvents: 1,
          ...fields,
        })
      ).status,
    ).toBe(400);
  const other = await setup(mf, "output-other");
  expect(
    (
      await act("output-other", other, {
        op: "process.output.read",
        id: "private",
        after: null,
        maxBytes: 16,
        maxEvents: 1,
      })
    ).status,
  ).toBe(404);
});

test("runtime failures expose unobserved output rather than a fabricated empty successful stream", async () => {
  const token = await setup(mf, "output-failed");
  expect(
    (
      await act("output-failed", token, {
        op: "process.run",
        id: "fuel",
        language: "javascript",
        source: "export default () => { while (true) {} }",
      })
    ).status,
  ).toBe(200);
  const output = await read("output-failed", token, "fuel", null);
  expect(output.state).toBe("failed");
  expect(output.availability).toBe("unobserved");
  expect(output.events).toEqual([]);
  const observer = Schema.decodeUnknownSync(RunRecord)(
    await (
      await act("output-failed", token, {
        op: "python.evaluate",
        id: "observer",
        expression:
          '(await tools.call({"op":"process.output.read","id":"fuel","after":None,"maxBytes":16,"maxEvents":1}))["availability"]',
      })
    ).json(),
  );
  expect(observer.output?.exitCode).toBe(0);
  expect(observer.output?.result).toBe("unobserved");
});

test("queued output is pending and completed replay survives replacing the Worker", async () => {
  const persisted = await mkdtemp(join(tmpdir(), "cirro-output-restart-"));
  const first = runtime(persisted, undefined, 1, false);
  const id = "output-restart";
  const token = await setup(first, id);
  const path = `/v1/sandboxes/${id}/action`;
  const accepted = await post(first, path, token, {
    op: "process.spawn",
    execution: { op: "process.run", id: "pending", language: "shell", source: "echo pending" },
  });
  expect([200, 500]).toContain(accepted.status);
  const pending = Schema.decodeUnknownSync(ProcessOutputPage)(
    await (
      await post(first, path, token, {
        op: "process.output.read",
        id: "pending",
        after: null,
        maxBytes: 16,
        maxEvents: 1,
      })
    ).json(),
  );
  expect(pending.state).toBe("queued");
  expect(pending.availability).toBe("pending");
  expect(pending.events).toEqual([]);
  expect(
    (
      await post(first, path, token, {
        op: "process.output.read",
        id: "pending",
        after: 1,
        maxBytes: 16,
        maxEvents: 1,
      })
    ).status,
  ).toBe(400);
  expect(
    (
      await post(first, path, token, {
        op: "process.run",
        id: "completed",
        language: "python",
        source: 'print("captured")\n42',
      })
    ).status,
  ).toBe(200);
  const original = Schema.decodeUnknownSync(ProcessOutputPage)(
    await (
      await post(first, path, token, {
        op: "process.output.read",
        id: "completed",
        after: null,
        maxBytes: 16,
        maxEvents: 1,
      })
    ).json(),
  );
  expect(original.availability).toBe("retained");
  await first.dispose();
  const second = runtime(persisted, undefined, 1, false);
  const restored = Schema.decodeUnknownSync(ProcessOutputPage)(
    await (
      await post(second, path, token, {
        op: "process.output.read",
        id: "completed",
        after: null,
        maxBytes: 16,
        maxEvents: 1,
      })
    ).json(),
  );
  expect(restored).toEqual(original);
  await second.dispose();
  await rm(persisted, { recursive: true, force: true });
});
