import { afterAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Schema, Struct } from "effect";
import {
  ProcessOutputPage,
  RunRecord,
  TokenResponse,
  StoredRun,
  StoredRunMetadata,
  Capability,
  MigrationReceipt,
  OutputMigrationReceipt,
} from "../src/contracts";
import { runtime } from "../tooling/worker-test";

const directory = await mkdtemp(join(tmpdir(), "cirro-output-"));
const mf = runtime(directory, { consume: true, controlled: false });
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
  const first = runtime(persisted, { consume: false, controlled: false });
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
  const second = runtime(persisted, { consume: false, controlled: false });
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

test("output pages read only addressed immutable blocks and reject corrupted addressed bytes", async () => {
  const token = await setup(mf, "output-blocks");
  const result = Schema.decodeUnknownSync(RunRecord)(
    await (
      await act("output-blocks", token, {
        op: "process.run",
        id: "blocks",
        language: "javascript",
        source:
          'export default ({console}) => { console.log("A".repeat(65536) + "😀" + "B".repeat(65536) + "C".repeat(30000)); return 42; }',
      })
    ).json(),
  );
  const bucket = await mf.objects;
  const object = await bucket.get("processes/output-blocks/blocks.json");
  if (object === null) return expect(object).not.toBeNull();
  expect(object.size).toBeLessThan(1000);
  const stored = Schema.decodeUnknownSync(Schema.fromJsonString(StoredRun))(await object.text());
  if (stored.output === null) return expect(stored.output).not.toBeNull();
  expect(stored.output.stdout.chunks).toHaveLength(3);
  const hash = stored.output.stdout.chunks[1];
  const key = `sandboxes/output-blocks/stdio/${hash}`;
  const block = await bucket.get(key);
  if (block === null) return expect(block).not.toBeNull();
  const bytes = await block.arrayBuffer();
  await bucket.put(key, Buffer.alloc(bytes.byteLength, 88));
  const initial = await read("output-blocks", token, "blocks", 0, 4096, 1);
  expect(Buffer.from(initial.events[0]?.data ?? "", "base64").toString()).toBe("A".repeat(4096));
  const corrupt = await act("output-blocks", token, {
    op: "process.output.read",
    id: "blocks",
    after: 65536,
    maxBytes: 1,
    maxEvents: 1,
  });
  expect(corrupt.status).toBe(500);
  await bucket.put(key, bytes);
  const boundary = await read("output-blocks", token, "blocks", 65535, 6, 1);
  expect(Buffer.from(boundary.events[0]?.data ?? "", "base64")).toEqual(
    Buffer.from(result.output?.stdout ?? "").subarray(65535, 65541),
  );
  const restored = Schema.decodeUnknownSync(RunRecord)(
    await (await act("output-blocks", token, { op: "process.get", id: "blocks" })).json(),
  );
  expect(restored).toEqual(result);
});

test("inline receipt migration preserves grants, deadlines, observed output and all process states", async () => {
  const token = await setup(mf, "output-migration");
  const bucket = await mf.objects;
  const Inline = RunRecord.mapFields((fields) => ({
    ...fields,
    authority: Schema.NullOr(Capability),
    deadlineAt: Schema.NullOr(Schema.Int),
  }));
  const grant = {
    sandboxId: "output-migration",
    permissions: ["read", "execute"] as const,
    expiresAt: Date.now() + 60000,
  };
  for (const status of [
    "queued",
    "running",
    "cancelling",
    "cancelled",
    "failed",
    "exited",
  ] as const) {
    const record = {
      id: status,
      status,
      sourceHash: "0".repeat(64),
      language: "javascript" as const,
      startedAt: 10,
      finishedAt: null,
      output: { stdout: "😀".repeat(20000), stderr: "retained", result: null, exitCode: null },
      authority: grant,
      deadlineAt: 123456,
    };
    await bucket.put(
      `processes/output-migration/${status}.json`,
      Schema.encodeSync(Schema.fromJsonString(Inline))(record),
      {
        customMetadata: {
          format: "run-v2",
          summary: Schema.encodeSync(
            Schema.fromJsonString(RunRecord.mapFields((fields) => Struct.omit(fields, ["output"]))),
          )(Struct.omit(record, ["output", "authority", "deadlineAt"])),
        },
      },
    );
  }
  const migrate = await post(
    mf,
    "/v1/migrations/output-chunks-v1",
    "cirro-local-test-credential",
    {},
  );
  expect(migrate.status).toBe(200);
  expect(Schema.decodeUnknownSync(MigrationReceipt)(await migrate.json())).toEqual({ migrated: 6 });
  for (const status of [
    "queued",
    "running",
    "cancelling",
    "cancelled",
    "failed",
    "exited",
  ] as const) {
    const object = await bucket.get(`processes/output-migration/${status}.json`);
    if (object === null) return expect(object).not.toBeNull();
    const stored = Schema.decodeUnknownSync(Schema.fromJsonString(StoredRun))(await object.text());
    expect(stored.authority).toEqual(grant);
    expect(stored.deadlineAt).toBe(123456);
    expect(Schema.decodeUnknownSync(StoredRunMetadata)(object.customMetadata).format).toBe(
      "run-v5",
    );
    const record = Schema.decodeUnknownSync(RunRecord)(
      await (await act("output-migration", token, { op: "process.get", id: status })).json(),
    );
    expect(record.status).toBe(status);
    expect(record.output).toEqual({
      stdout: "😀".repeat(20000),
      stderr: "retained",
      result: null,
      exitCode: null,
    });
  }
  const repeated = await post(
    mf,
    "/v1/migrations/output-chunks-v1",
    "cirro-local-test-credential",
    {},
  );
  expect(repeated.status).toBe(200);
  expect(Schema.decodeUnknownSync(MigrationReceipt)(await repeated.json())).toEqual({
    migrated: 0,
  });
  expect((await post(mf, "/v1/migrations/output-chunks-v1", token, {})).status).toBe(401);
});

test("historical receipt migration remains resumable after fencing and a conflicting target", async () => {
  const token = await setup(mf, "output-fence");
  const record = Schema.decodeUnknownSync(RunRecord)(
    await (
      await act("output-fence", token, {
        op: "process.run",
        id: "saved",
        language: "javascript",
        source: 'export default ({console}) => { console.log("retained"); return 42; }',
      })
    ).json(),
  );
  const bucket = await mf.objects;
  const legacy = "sandboxes/output-fence/runs/saved.json";
  const primary = "processes/output-fence/saved.json";
  await bucket.put(legacy, Schema.encodeSync(Schema.fromJsonString(RunRecord))(record));
  await bucket.put(primary, "conflicting target");
  const failed = await post(
    mf,
    "/v1/migrations/process-receipts-v2",
    "cirro-local-test-credential",
    {},
  );
  expect(failed.status).toBe(500);
  const fenced = await bucket.get(legacy);
  if (fenced === null) return expect(fenced).not.toBeNull();
  expect(Schema.decodeUnknownSync(Schema.fromJsonString(RunRecord))(await fenced.text())).toEqual(
    record,
  );
  await bucket.delete(primary);
  const resumed = await post(
    mf,
    "/v1/migrations/process-receipts-v2",
    "cirro-local-test-credential",
    {},
  );
  expect(resumed.status).toBe(200);
  expect(Schema.decodeUnknownSync(MigrationReceipt)(await resumed.json()).migrated).toBe(1);
  expect(await bucket.head(legacy)).toBeNull();
  const restored = Schema.decodeUnknownSync(RunRecord)(
    await (await act("output-fence", token, { op: "process.get", id: "saved" })).json(),
  );
  expect(restored).toEqual(record);
});
test("version 3 chunked receipts migrate to explicit closed stdin without rewriting output blocks", async () => {
  const token = await setup(mf, "input-migration");
  const response = await post(mf, "/v1/sandboxes/input-migration/action", token, {
    op: "process.run",
    id: "old",
    language: "javascript",
    source: 'export default ()=>{console.log("retained");return 7;}',
  });
  expect(response.status).toBe(200);
  const bucket = await mf.objects;
  const key = "processes/input-migration/old.json";
  const object = await bucket.get(key);
  expect(object).not.toBeNull();
  if (object === null) return;
  const record = Schema.decodeUnknownSync(Schema.fromJsonString(StoredRun))(await object.text());
  const metadata = Schema.decodeUnknownSync(StoredRunMetadata)(object.customMetadata);
  await bucket.put(key, JSON.stringify(Struct.omit(record, ["stdinMode", "checkpoint"])), {
    customMetadata: { format: "run-v3", summary: JSON.stringify(metadata.summary) },
  });
  const migrated = await post(
    mf,
    "/v1/migrations/output-chunks-v1",
    "cirro-local-test-credential",
    {},
  );
  expect(migrated.status).toBe(200);
  const current = await bucket.get(key);
  expect(current).not.toBeNull();
  if (current === null) return;
  const updated = Schema.decodeUnknownSync(Schema.fromJsonString(StoredRun))(await current.text());
  expect(updated.stdinMode).toBe("closed");
  expect(updated.output).toEqual(record.output);
  expect(updated.sourceHash).toBe(record.sourceHash);
  expect(Schema.decodeUnknownSync(StoredRunMetadata)(current.customMetadata).format).toBe("run-v5");
  expect(
    (await post(mf, "/v1/migrations/output-chunks-v1", "cirro-local-test-credential", {})).status,
  ).toBe(200);
});
test("receipt migration returns bounded page cursors and skips confirmed conversions on retry", async () => {
  const persisted = await mkdtemp(join(tmpdir(), "cirro-migration-pages-"));
  const instance = runtime(persisted, { consume: true, controlled: false });
  await setup(instance, "paged");
  const bucket = await instance.objects;
  for (const index of Array.from({ length: 101 }, (_, index) => index)) {
    const record = {
      id: `old-${String(index).padStart(3, "0")}`,
      status: "exited" as const,
      sourceHash: "a".repeat(64),
      language: "wasm" as const,
      startedAt: 0,
      finishedAt: 1,
      output: null,
      authority: null,
      deadlineAt: null,
    };
    await bucket.put(`processes/paged/${record.id}.json`, JSON.stringify(record), {
      customMetadata: {
        format: "run-v3",
        summary: JSON.stringify(Struct.omit(record, ["output", "authority", "deadlineAt"])),
      },
    });
  }
  const cursors: (typeof OutputMigrationReceipt.Type.cursor)[] = [null];
  const progress = { pages: 0, migrated: 0 };
  while (cursors.length > 0) {
    const cursor = cursors.shift();
    const response = await post(
      instance,
      "/v1/migrations/output-chunks-v1",
      "cirro-local-test-credential",
      { cursor },
    );
    expect(response.status).toBe(200);
    const page = Schema.decodeUnknownSync(OutputMigrationReceipt)(await response.json());
    progress.pages += 1;
    progress.migrated += page.migrated;
    expect(page.migrated).toBeLessThanOrEqual(50);
    if (progress.pages === 1) {
      const pending = await bucket.get("processes/paged/old-100.json");
      expect(pending?.customMetadata?.format).toBe("run-v3");
    }
    if (page.cursor !== null) cursors.push(page.cursor);
  }
  expect(progress.pages).toBe(3);
  expect(progress.migrated).toBe(101);
  const last = await bucket.get("processes/paged/old-100.json");
  expect(last?.customMetadata?.format).toBe("run-v5");
  const retry = await post(
    instance,
    "/v1/migrations/output-chunks-v1",
    "cirro-local-test-credential",
    {},
  );
  expect(retry.status).toBe(200);
  expect(Schema.decodeUnknownSync(OutputMigrationReceipt)(await retry.json()).migrated).toBe(0);
  await instance.dispose();
  await rm(persisted, { recursive: true, force: true });
}, 15000);
