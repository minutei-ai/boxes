import { afterAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Layer, Redacted, Schema } from "effect";
import { FetchHttpClient } from "effect/http";
import { make } from "../src/sdk";
import { FilesystemSnapshot, ProcessDelivery, StoredRun } from "../src/contracts";
import { runtime } from "../tooling/worker-test";

const directory = await mkdtemp(join(tmpdir(), "boxes-restore-"));
const first = runtime(directory, { advance: 30000 });
const instances = [first];
const transport = FetchHttpClient.layer.pipe(
  Layer.provide(Layer.succeed(FetchHttpClient.RequestInit, { keepalive: false })),
);
const run = <A, E>(program: Effect.Effect<A, E, import("effect/http/HttpClient").HttpClient>) =>
  Effect.runPromise(program.pipe(Effect.provide(transport)));
const policy = {
  networkHosts: [],
  interruptBudget: 1000,
  memoryBytes: 8388608,
  maxOutputBytes: 1048576,
};
const admin = await run(
  make({
    url: (await first.ready).toString(),
    token: Redacted.make("cirro-local-test-credential"),
  }),
);
await run(admin.create({ id: "restore", policy }));
const grant = await run(
  admin.mintCapability("restore", {
    permissions: ["read", "write", "manage", "execute"],
    expiresInSeconds: 3600,
  }),
);
const boxes = await run(
  make({ url: (await first.ready).toString(), token: Redacted.make(grant.token) }),
);
afterAll(async () => {
  for (const instance of instances) await instance.dispose();
  await rm(directory, { recursive: true, force: true });
});
test("restore replaces the root atomically, preserves policy and credentials, and allocates fresh inode identities", async () => {
  await run(
    boxes.action("restore", {
      op: "filesystem.writeFile",
      path: "/tmp/data",
      content: "binary\u0000value",
      encoding: "utf8",
    }),
  );
  await run(
    boxes.action("restore", { op: "filesystem.symlink", path: "/alias", target: "tmp/data" }),
  );
  await run(
    boxes.action("restore", {
      op: "filesystem.chown",
      path: "/tmp/data",
      uid: 1000,
      gid: 1001,
      follow: true,
    }),
  );
  const manifest = Buffer.concat([
    Buffer.from([4]),
    Buffer.from("echo"),
    Buffer.from([5]),
    Buffer.from("1.0.0"),
    Buffer.from([0, 0, 0]),
  ]);
  const header = Buffer.from([0x89, 65, 79, 83, 2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
  header.writeUInt32LE(manifest.length + 2, 8);
  header.writeUInt32LE(3, 12);
  const archive = Buffer.concat([
    header,
    Buffer.from([2, 0]),
    manifest,
    Buffer.from([2, 0, 0]),
    Buffer.alloc(1024),
  ]);
  await run(
    boxes.action("restore", {
      op: "filesystem.writeFile",
      path: "/tmp/package.aospkg",
      content: archive.toString("base64"),
      encoding: "base64",
    }),
  );
  await run(
    boxes.action("restore", { op: "software.install", source: { path: "/tmp/package.aospkg" } }),
  );
  expect((await run(boxes.action("restore", { op: "software.list" }))).length).toBe(1);
  const before = await run(
    boxes.action("restore", { op: "filesystem.stat", path: "/tmp/data", follow: true }),
  );
  const snapshot = await run(
    boxes.action("restore", { op: "filesystem.export", maxBytes: 1048576 }),
  );
  await run(
    boxes.action("restore", { op: "filesystem.remove", path: "/tmp/data", recursive: false }),
  );
  await run(
    boxes.action("restore", {
      op: "filesystem.writeFile",
      path: "/extra",
      content: "remove",
      encoding: "utf8",
    }),
  );
  const status = await run(boxes.action("restore", { op: "vm.status" }));
  expect((await run(boxes.action("restore", { op: "filesystem.restore", snapshot }))).ok).toBe(
    true,
  );
  const after = await run(
    boxes.action("restore", { op: "filesystem.stat", path: "/tmp/data", follow: true }),
  );
  expect(after.inode).toBeGreaterThan(before.inode);
  expect([after.uid, after.gid, after.size, after.mode]).toEqual([
    before.uid,
    before.gid,
    before.size,
    before.mode,
  ]);
  expect(
    (await run(boxes.action("restore", { op: "filesystem.exists", path: "/extra" }))).exists,
  ).toBe(false);
  const restored = await run(
    boxes.action("restore", { op: "filesystem.export", maxBytes: 1048576 }),
  );
  expect(restored).toEqual(snapshot);
  expect(await run(boxes.action("restore", { op: "software.list" }))).toEqual([]);
  expect(
    await run(
      boxes
        .action("restore", { op: "filesystem.chmod", path: "/opt/cirro", mode: 511 })
        .pipe(Effect.flip),
    ),
  ).toMatchObject({ _tag: "BoxesError", status: 403 });
  const current = await run(boxes.action("restore", { op: "vm.status" }));
  expect(current.policy).toEqual(status.policy);
  expect(current.generation).toBe(status.generation + 1);
  const readonly = await run(
    admin.mintCapability("restore", { permissions: ["read", "write"], expiresInSeconds: 600 }),
  );
  const writer = await run(
    make({ url: (await first.ready).toString(), token: Redacted.make(readonly.token) }),
  );
  expect(
    await run(writer.action("restore", { op: "filesystem.restore", snapshot }).pipe(Effect.flip)),
  ).toMatchObject({ _tag: "BoxesError", status: 403 });
  const invalid = {
    ...snapshot,
    source: {
      ...snapshot.source,
      filesystem: {
        entries: [
          {
            path: "/bad/value",
            type: "file",
            mode: "0644",
            uid: 0,
            gid: 0,
            encoding: "base64",
            content: "eA==",
          },
        ],
      },
    },
  };
  expect(
    await run(
      boxes
        .action("restore", {
          op: "filesystem.restore",
          snapshot: Schema.decodeUnknownSync(FilesystemSnapshot)(invalid),
        })
        .pipe(Effect.flip),
    ),
  ).toMatchObject({ _tag: "BoxesError", status: 400 });
  expect((await run(boxes.action("restore", { op: "vm.status" }))).generation).toBe(
    current.generation,
  );
  expect(
    await run(boxes.action("restore", { op: "filesystem.export", maxBytes: 1048576 })),
  ).toEqual(snapshot);
});
test("concurrent restores publish complete candidate roots without mixing file contents", async () => {
  const makeSnapshot = (content: string) =>
    Schema.decodeUnknownSync(FilesystemSnapshot)({
      kind: "snapshot-export",
      source: {
        format: "boxes-filesystem-snapshot-v1",
        filesystem: {
          entries: [
            { path: "/", type: "directory", mode: "0755", uid: 0, gid: 0 },
            {
              path: "/candidate",
              type: "file",
              mode: "0644",
              uid: 0,
              gid: 0,
              content,
              encoding: "base64",
            },
          ],
        },
      },
    });
  const candidates = [
    makeSnapshot(Buffer.alloc(1048576, 65).toString("base64")),
    makeSnapshot(Buffer.alloc(1048576, 66).toString("base64")),
  ];
  const generation = (await run(boxes.action("restore", { op: "vm.status" }))).generation;
  const outcomes = await Promise.all(
    candidates.map((snapshot) =>
      run(boxes.action("restore", { op: "filesystem.restore", snapshot }).pipe(Effect.result)),
    ),
  );
  expect(outcomes.some((outcome) => outcome._tag === "Success")).toBe(true);
  for (const outcome of outcomes) {
    if (outcome._tag === "Failure")
      expect(outcome.failure).toMatchObject({ _tag: "BoxesError", status: 409 });
  }
  const published = await run(
    boxes.action("restore", { op: "filesystem.export", maxBytes: 2097152 }),
  );
  expect(
    candidates.some(
      (candidate) =>
        Schema.encodeSync(Schema.fromJsonString(FilesystemSnapshot))(candidate) ===
        Schema.encodeSync(Schema.fromJsonString(FilesystemSnapshot))(published),
    ),
  ).toBe(true);
  expect((await run(boxes.action("restore", { op: "vm.status" }))).generation).toBe(
    generation + outcomes.filter((outcome) => outcome._tag === "Success").length,
  );
});
test("replacement Worker cannot resume an old checkpoint over a restored filesystem", async () => {
  await run(boxes.action("restore", { op: "filesystem.mkdir", path: "/tmp", recursive: false }));
  const source = Buffer.from(
    await Bun.file(join(import.meta.dir, "../dist/wasi-attenuation-checkpoint.wasm")).arrayBuffer(),
  ).toString("base64");
  await run(
    boxes.action("restore", {
      op: "process.spawn",
      execution: { op: "process.run", id: "stale", language: "wasm", source },
    }),
  );
  const key = "processes/restore/stale.json";
  const object = await (await first.objects).head(key);
  if (object === null) return expect(object).not.toBeNull();
  await (
    await first.control
  ).deliver("executions", [
    {
      id: "pause",
      timestamp: new Date(),
      attempts: 1,
      body: Schema.encodeSync(ProcessDelivery)({ key, eTag: object.etag }),
    },
  ]);
  const paused = await (await first.objects).get(key);
  if (paused === null) return expect(paused).not.toBeNull();
  expect(
    Schema.decodeUnknownSync(Schema.fromJsonString(StoredRun))(await paused.text()).checkpointCount,
  ).toBe(1);
  const snapshot = await run(
    boxes.action("restore", { op: "filesystem.export", maxBytes: 2097152 }),
  );
  await run(boxes.action("restore", { op: "filesystem.restore", snapshot }));
  const generation = (await run(boxes.action("restore", { op: "vm.status" }))).generation;
  await first.dispose();
  const second = runtime(directory, { clockStart: first.time, advance: 1000 });
  instances.splice(0, 1, second);
  const retained = await (await second.objects).head(key);
  if (retained === null) return expect(retained).not.toBeNull();
  await (
    await second.control
  ).deliver("executions", [
    {
      id: "resume",
      timestamp: new Date(),
      attempts: 1,
      body: Schema.encodeSync(ProcessDelivery)({ key, eTag: retained.etag }),
    },
  ]);
  const client = await run(
    make({ url: (await second.ready).toString(), token: Redacted.make(grant.token) }),
  );
  const record = await run(client.action("restore", { op: "process.get", id: "stale" }));
  expect(record.status).toBe("failed");
  expect(record.output?.stdout).toBe("rights checkpoint\n");
  expect((await run(client.action("restore", { op: "vm.status" }))).generation).toBe(generation);
  expect(
    await run(client.action("restore", { op: "filesystem.export", maxBytes: 2097152 })),
  ).toEqual(snapshot);
}, 15000);
