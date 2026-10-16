import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Schema, Match, Struct } from "effect";
import {
  RunRecord,
  StoredRun,
  TokenResponse,
  FileContent,
  ProcessDelivery,
  ExecutionCheckpoint,
  HeapSnapshot,
  StoredRunMetadata,
  RecoveryStatus,
} from "../src/contracts";
import { runtime } from "../tooling/worker-test";
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

for (const mode of ["synced", "unsynced"] as const) {
  test(`a ${mode} checkpointed Queue claim resumes across Worker replacement without repeating file writes or entry`, async () => {
    const artifact = Match.value(mode).pipe(
      Match.when("synced", () => "wasi-recovery.wasm"),
      Match.orElse(() => "wasi-recovery-unsynced.wasm"),
    );
    const source = Buffer.from(
      await Bun.file(join(import.meta.dir, `../dist/${artifact}`)).arrayBuffer(),
    ).toString("base64");
    const directory = await mkdtemp(join(tmpdir(), "cirro-process-recovery-"));
    const first = runtime(directory);
    expect(
      (
        await post(first, "/v1/sandboxes", "cirro-local-test-credential", {
          id: "recover",
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
        await post(first, "/v1/sandboxes/recover/capabilities", "cirro-local-test-credential", {
          permissions: ["read", "write", "execute"],
          expiresInSeconds: 3600,
        })
      ).json(),
    ).token;
    const path = "/v1/sandboxes/recover/action";
    const spawned = await post(first, path, token, {
      op: "process.spawn",
      execution: { op: "process.run", id: "job", language: "wasm", source },
    });
    expect([200, 500]).toContain(spawned.status);
    const bucket = await first.objects;
    const key = "processes/recover/job.json";
    const queued = await bucket.head(key);
    expect(queued).not.toBeNull();
    if (queued === null) return;
    const worker = await first.control;
    await worker.deliver("executions", [
      {
        id: "first",
        timestamp: new Date(),
        attempts: 1,
        body: Schema.encodeSync(ProcessDelivery)({ key, eTag: queued.etag }),
      },
    ]);
    const object = await bucket.get(key);
    expect(object).not.toBeNull();
    if (object === null) return;
    const paused = Schema.decodeUnknownSync(Schema.fromJsonString(StoredRun))(await object.text());
    expect(paused.status).toBe("queued");
    expect(paused.checkpoint).not.toBeNull();
    expect(paused.authority?.sandboxId).toBe("recover");
    expect(paused.output).not.toBeNull();
    if (paused.checkpoint === null) return;
    const checkpointObject = await bucket.get(
      `sandboxes/recover/execution-checkpoints/${paused.checkpoint}.json`,
    );
    expect(checkpointObject).not.toBeNull();
    if (checkpointObject === null) return;
    const checkpoint = Schema.decodeUnknownSync(Schema.fromJsonString(ExecutionCheckpoint))(
      await checkpointObject.text(),
    );
    expect(checkpoint.fuelUsed).toBeGreaterThanOrEqual(50000000);
    const observedFirst = await post(first, path, token, {
      op: "filesystem.readFile",
      path: "/tmp/recovery-counter",
    });
    if (mode === "synced") {
      expect(observedFirst.status).toBe(200);
      const firstFile = Schema.decodeUnknownSync(FileContent)(await observedFirst.json());
      expect(Buffer.from(firstFile.content, firstFile.encoding).toString()).toBe("A");
    } else expect(observedFirst.status).toBe(404);
    await first.dispose();
    const second = runtime(directory);
    const current = await (await second.objects).head(key);
    expect(current).not.toBeNull();
    if (current === null) return;
    const secondWorker = await second.control;
    const resume = () =>
      secondWorker.deliver("executions", [
        {
          id: "resume",
          timestamp: new Date(),
          attempts: 1,
          body: Schema.encodeSync(ProcessDelivery)({ key, eTag: current.etag }),
        },
      ]);
    const deliveries = await Promise.allSettled([resume(), resume()]);
    expect(deliveries.every((result) => result.status === "fulfilled")).toBe(true);
    const response = await post(second, path, token, { op: "process.get", id: "job" });
    expect(response.status).toBe(200);
    const finished = Schema.decodeUnknownSync(RunRecord)(await response.json());
    expect(finished.status).toBe("exited");
    const recovery = Schema.decodeUnknownSync(RecoveryStatus)(
      await (await post(second, path, token, { op: "process.recovery.status", id: "job" })).json(),
    );
    expect(recovery.checkpoints).toBe(1);
    expect(recovery.resumable).toBe(false);
    expect(finished.startedAt).toBe(paused.startedAt);
    expect(finished.output?.exitCode).toBe(0);
    expect(finished.output?.result).toBe(((3000000 * 2999999) / 2) % 1024);
    expect(finished.output?.stdout).toBe("entered once\n");
    const file = Schema.decodeUnknownSync(FileContent)(
      await (
        await post(second, path, token, {
          op: "filesystem.readFile",
          path: "/tmp/recovery-counter",
        })
      ).json(),
    );
    expect(Buffer.from(file.content, file.encoding).toString()).toBe("AB");
    await secondWorker.deliver("executions", [
      {
        id: "duplicate",
        timestamp: new Date(),
        attempts: 2,
        body: Schema.encodeSync(ProcessDelivery)({ key, eTag: current.etag }),
      },
    ]);
    const repeated = Schema.decodeUnknownSync(FileContent)(
      await (
        await post(second, path, token, {
          op: "filesystem.readFile",
          path: "/tmp/recovery-counter",
        })
      ).json(),
    );
    expect(Buffer.from(repeated.content, repeated.encoding).toString()).toBe("AB");
    await second.dispose();
    await rm(directory, { recursive: true, force: true });
  }, 30000);
}
for (const role of ["root", "family", "stopped", "stopped-delayed"] as const) {
  test(`${role} blocked stdin checkpoints and resumes with buffered bytes and EOF after Worker replacement`, async () => {
    const directory = await mkdtemp(join(tmpdir(), "cirro-idle-recovery-"));
    const first = runtime(directory, { advance: 30000 });
    expect(
      (
        await post(first, "/v1/sandboxes", "cirro-local-test-credential", {
          id: "idle",
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
        await post(first, "/v1/sandboxes/idle/capabilities", "cirro-local-test-credential", {
          permissions: ["read", "write", "execute"],
          expiresInSeconds: 3600,
        })
      ).json(),
    ).token;
    const path = "/v1/sandboxes/idle/action";
    const artifact = Match.value(role).pipe(
      Match.when("family", () => "wasi-recovery-family.wasm"),
      Match.when("stopped", () => "wasi-recovery-stopped.wasm"),
      Match.when("stopped-delayed", () => "wasi-recovery-stopped-delayed.wasm"),
      Match.orElse(() => "wasi-stdin.wasm"),
    );
    if (role !== "root") {
      const childArtifact = Match.value(role).pipe(
        Match.when("stopped", () => "wasi-stdin-resume-parent.wasm"),
        Match.when("stopped-delayed", () => "wasi-stdin-resume-parent.wasm"),
        Match.orElse(() => "wasi-stdin.wasm"),
      );
      const child = Buffer.from(
        await Bun.file(join(import.meta.dir, `../dist/${childArtifact}`)).arrayBuffer(),
      ).toString("base64");
      expect(
        (
          await post(first, path, token, {
            op: "filesystem.writeFile",
            path: "/tmp/recovery-child.wasm",
            content: child,
            encoding: "base64",
          })
        ).status,
      ).toBe(200);
      expect(
        (
          await post(first, path, token, {
            op: "filesystem.chmod",
            path: "/tmp/recovery-child.wasm",
            mode: 493,
          })
        ).status,
      ).toBe(200);
    }
    const source = Buffer.from(
      await Bun.file(join(import.meta.dir, `../dist/${artifact}`)).arrayBuffer(),
    ).toString("base64");
    const spawned = await post(first, path, token, {
      op: "process.spawn",
      stdinMode: "pipe",
      execution: {
        op: "process.run",
        id: "job",
        language: "wasm",
        source,
        stdin: { content: "before:", encoding: "utf8" },
      },
    });
    expect([200, 500]).toContain(spawned.status);
    const bucket = await first.objects;
    const key = "processes/idle/job.json";
    const original = await bucket.head(key);
    expect(original).not.toBeNull();
    if (original === null) return;
    await (
      await first.control
    ).deliver("executions", [
      {
        id: "idle-start",
        timestamp: new Date(),
        attempts: 1,
        body: Schema.encodeSync(ProcessDelivery)({ key, eTag: original.etag }),
      },
    ]);
    const object = await bucket.get(key);
    expect(object).not.toBeNull();
    if (object === null) return;
    const paused = Schema.decodeUnknownSync(Schema.fromJsonString(StoredRun))(await object.text());
    expect(paused.status).toBe("queued");
    expect(paused.checkpoint).not.toBeNull();
    expect(paused.checkpointCount).toBe(1);
    if (paused.checkpoint === null) return;
    const envelopeObject = await bucket.get(
      `sandboxes/idle/execution-checkpoints/${paused.checkpoint}.json`,
    );
    expect(envelopeObject).not.toBeNull();
    if (envelopeObject === null) return;
    const envelope = Schema.decodeUnknownSync(Schema.fromJsonString(ExecutionCheckpoint))(
      await envelopeObject.text(),
    );
    expect(envelope.savedAt).toBe(first.time);
    const heapObject = await bucket.get(`sandboxes/idle/checkpoints/${envelope.heap}.json`);
    expect(heapObject).not.toBeNull();
    if (heapObject === null) return;
    const heap = Schema.decodeUnknownSync(Schema.fromJsonString(HeapSnapshot))(
      await heapObject.text(),
    );
    expect(heap.handles.map((handle) => handle.pid).sort()).toEqual(
      Match.value(role).pipe(
        Match.when("root", () => [1]),
        Match.orElse(() => [1, 2]),
      ),
    );
    expect(
      (
        await post(first, path, token, {
          op: "process.stdin.write",
          id: "job",
          offset: 7,
          content: "after",
          encoding: "utf8",
        })
      ).status,
    ).toBe(200);
    expect(
      (await post(first, path, token, { op: "process.stdin.close", id: "job", offset: 12 })).status,
    ).toBe(200);
    const time = first.time;
    await first.dispose();
    const second = runtime(directory, { clockStart: time });
    const current = await (await second.objects).head(key);
    expect(current).not.toBeNull();
    if (current === null) return;
    await (
      await second.control
    ).deliver("executions", [
      {
        id: "idle-resume",
        timestamp: new Date(),
        attempts: 1,
        body: Schema.encodeSync(ProcessDelivery)({ key, eTag: current.etag }),
      },
    ]);
    const result = await post(second, path, token, { op: "process.get", id: "job" });
    expect(result.status).toBe(200);
    const record = Schema.decodeUnknownSync(RunRecord)(await result.json());
    expect(record.status).toBe("exited");
    expect(record.output?.exitCode).toBe(0);
    expect(record.output?.stdout).toBe("ready\nbefore:after\nbytes=12\n");
    await second.dispose();
    await rm(directory, { recursive: true, force: true });
  }, 45000);
}
const prepareGuard = async () => {
  const directory = await mkdtemp(join(tmpdir(), "cirro-recovery-guard-"));
  const first = runtime(directory);
  expect(
    (
      await post(first, "/v1/sandboxes", "cirro-local-test-credential", {
        id: "guard",
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
      await post(first, "/v1/sandboxes/guard/capabilities", "cirro-local-test-credential", {
        permissions: ["read", "write", "execute"],
        expiresInSeconds: 3600,
      })
    ).json(),
  ).token;
  const path = "/v1/sandboxes/guard/action";
  const source = Buffer.from(
    await Bun.file(join(import.meta.dir, "../dist/wasi-recovery.wasm")).arrayBuffer(),
  ).toString("base64");
  const response = await post(first, path, token, {
    op: "process.spawn",
    execution: { op: "process.run", id: "job", language: "wasm", source },
  });
  expect([200, 500]).toContain(response.status);
  const bucket = await first.objects;
  const key = "processes/guard/job.json";
  const before = await bucket.head(key);
  expect(before).not.toBeNull();
  if (before === null) return;
  const worker = await first.control;
  await worker.deliver("executions", [
    {
      id: "prepare",
      timestamp: new Date(),
      attempts: 1,
      body: Schema.encodeSync(ProcessDelivery)({ key, eTag: before.etag }),
    },
  ]);
  const object = await bucket.get(key);
  expect(object).not.toBeNull();
  if (object === null) return;
  const paused = Schema.decodeUnknownSync(Schema.fromJsonString(StoredRun))(await object.text());
  expect(paused.status).toBe("queued");
  expect(paused.checkpoint).not.toBeNull();
  return { directory, first, token, path, bucket, key, worker, paused };
};
for (const mode of ["expired", "cancelled", "corrupt"] as const) {
  test(`checkpoint ${mode} cannot reenter the guest and retains acknowledged output`, async () => {
    const context = await prepareGuard();
    expect(context).toBeDefined();
    if (context === undefined) return;
    if (mode === "cancelled") {
      expect(
        (
          await post(context.first, context.path, context.token, {
            op: "process.cancel",
            id: "job",
          })
        ).status,
      ).toBe(200);
    }
    if (mode === "expired") {
      const authority = context.paused.authority;
      expect(authority).not.toBeNull();
      if (authority === null) return;
      await context.bucket.put(
        context.key,
        Schema.encodeSync(Schema.fromJsonString(StoredRun))({
          ...context.paused,
          authority: { ...authority, expiresAt: 0 },
        }),
        {
          customMetadata: Schema.encodeSync(StoredRunMetadata)({
            format: "run-v6",
            summary: {
              ...Struct.omit(context.paused, [
                "output",
                "authority",
                "deadlineAt",
                "checkpoint",
                "inputMode",
              ]),
              stdinMode: context.paused.inputMode,
            },
          }),
        },
      );
    }
    if (mode === "corrupt") {
      const hash = context.paused.checkpoint;
      expect(hash).not.toBeNull();
      if (hash === null) return;
      await context.bucket.put(`sandboxes/guard/execution-checkpoints/${hash}.json`, "corrupted");
    }
    const object = await context.bucket.head(context.key);
    expect(object).not.toBeNull();
    if (object === null) return;
    await context.worker.deliver("executions", [
      {
        id: "guard",
        timestamp: new Date(),
        attempts: 1,
        body: Schema.encodeSync(ProcessDelivery)({ key: context.key, eTag: object.etag }),
      },
    ]);
    const response = await post(context.first, context.path, context.token, {
      op: "process.get",
      id: "job",
    });
    expect(response.status).toBe(200);
    const record = Schema.decodeUnknownSync(RunRecord)(await response.json());
    expect(record.status).toBe(
      Match.value(mode).pipe(
        Match.when("cancelled", () => "cancelled" as const),
        Match.orElse(() => "failed" as const),
      ),
    );
    expect(record.output?.stdout).toBe("entered once\n");
    const file = Schema.decodeUnknownSync(FileContent)(
      await (
        await post(context.first, context.path, context.token, {
          op: "filesystem.readFile",
          path: "/tmp/recovery-counter",
        })
      ).json(),
    );
    expect(Buffer.from(file.content, file.encoding).toString()).toBe("A");
    await context.first.dispose();
    await rm(context.directory, { recursive: true, force: true });
  }, 15000);
}
