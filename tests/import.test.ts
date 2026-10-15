import { afterAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Schema } from "effect";
import {
  CreateSandbox,
  FilesystemSnapshot,
  FileContent,
  FileStat,
  TokenResponse,
  Status,
} from "../src/contracts";
import { runtime } from "../tooling/worker-test";
const directory = await mkdtemp(join(tmpdir(), "boxes-import-"));
const first = runtime(directory, { controlled: false });
const policy = {
  networkHosts: [],
  interruptBudget: 1000,
  memoryBytes: 8388608,
  maxOutputBytes: 1048576,
};
const snapshot = Schema.decodeUnknownSync(FilesystemSnapshot)({
  kind: "snapshot-export",
  source: {
    format: "boxes-filesystem-snapshot-v1",
    filesystem: {
      entries: [
        {
          path: "/data/value",
          type: "file",
          mode: "0444",
          uid: 1000,
          gid: 1001,
          content: Buffer.from([0, 255, 128, 10]).toString("base64"),
          encoding: "base64",
        },
        {
          path: "/alias",
          type: "symlink",
          mode: "0777",
          uid: 2000,
          gid: 2001,
          target: "data/value",
        },
        { path: "/", type: "directory", mode: "0755", uid: 42, gid: 43 },
        { path: "/data", type: "directory", mode: "0555", uid: 1002, gid: 1003 },
      ],
    },
  },
});
const post = async (
  instance: ReturnType<typeof runtime>,
  path: string,
  body: unknown,
  token = "cirro-local-test-credential",
) =>
  fetch(new URL(path, await instance.ready), {
    method: "POST",
    keepalive: false,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
afterAll(async () => {
  await first.dispose();
  await rm(directory, { recursive: true, force: true });
});
test("snapshot creation restores binary bytes, modes, ownership and relative symlinks atomically across Worker replacement", async () => {
  const created = await post(first, "/v1/sandboxes", {
    id: "restored",
    policy,
    snapshot,
  } satisfies typeof CreateSandbox.Type);
  expect(created.status).toBe(201);
  expect(Schema.decodeUnknownSync(Status)(await created.json()).filesystemBytes).toBe(4);
  const token = Schema.decodeUnknownSync(TokenResponse)(
    await (
      await post(first, "/v1/sandboxes/restored/capabilities", {
        permissions: ["read"],
        expiresInSeconds: 3600,
      })
    ).json(),
  ).token;
  const path = "/v1/sandboxes/restored/action";
  const before = Schema.decodeUnknownSync(FilesystemSnapshot)(
    await (await post(first, path, { op: "filesystem.export", maxBytes: 1048576 }, token)).json(),
  );
  expect(before.source.filesystem.entries.toSorted((a, b) => a.path.localeCompare(b.path))).toEqual(
    snapshot.source.filesystem.entries.toSorted((a, b) => a.path.localeCompare(b.path)),
  );
  expect((await post(first, "/v1/sandboxes", { id: "restored", policy, snapshot })).status).toBe(
    409,
  );
  expect(
    (await post(first, "/v1/sandboxes", { id: "unauthorized", policy, snapshot }, token)).status,
  ).toBe(401);
  await first.dispose();
  const second = runtime(directory, { controlled: false });
  const contents = Schema.decodeUnknownSync(FileContent)(
    await (await post(second, path, { op: "filesystem.readFile", path: "/alias" }, token)).json(),
  );
  expect(contents.content).toBe(Buffer.from([0, 255, 128, 10]).toString("base64"));
  const link = Schema.decodeUnknownSync(FileStat)(
    await (
      await post(second, path, { op: "filesystem.stat", path: "/alias", follow: false }, token)
    ).json(),
  );
  expect([link.uid, link.gid]).toEqual([2000, 2001]);
  expect(
    (await post(second, path, { op: "filesystem.stat", path: "/home", follow: true }, token))
      .status,
  ).toBe(404);
  await second.dispose();
});
test("malformed snapshot graphs fail before uploading content or publishing a sandbox", async () => {
  const root = { path: "/", type: "directory", mode: "0755", uid: 0, gid: 0 };
  const file = {
    path: "/value",
    type: "file",
    mode: "0644",
    uid: 0,
    gid: 0,
    content: "YQ==",
    encoding: "base64",
  };
  const persisted = await mkdtemp(join(tmpdir(), "boxes-invalid-import-"));
  const instance = runtime(persisted, { controlled: false });
  for (const [index, entries] of [
    [file],
    [root, root],
    [root, { ...file, path: "relative" }],
    [root, { ...file, path: "/dir/value" }],
    [root, { ...file, path: "/a/../value" }],
    [root, { ...file, content: "YR==" }],
    [
      root,
      file,
      { path: "/alias", type: "symlink", mode: "0600", uid: 0, gid: 0, target: "/value" },
    ],
    [root, { ...file, mode: "04755" }],
    [root, file, { ...file, path: "/value/child" }],
  ].entries()) {
    const id = `invalid-${index}`;
    expect(
      (
        await post(instance, "/v1/sandboxes", {
          id,
          policy,
          snapshot: {
            kind: "snapshot-export",
            source: { format: "boxes-filesystem-snapshot-v1", filesystem: { entries } },
          },
        })
      ).status,
    ).toBe(400);
    expect((await (await instance.objects).list({ prefix: `sandboxes/${id}/` })).objects).toEqual(
      [],
    );
  }
  await instance.dispose();
  await rm(persisted, { recursive: true, force: true });
});
test("concurrent snapshot creates publish one complete root without overwriting or merging entries", async () => {
  const persisted = await mkdtemp(join(tmpdir(), "boxes-racing-import-"));
  const instance = runtime(persisted, { controlled: false });
  const root = { path: "/", type: "directory", mode: "0755", uid: 0, gid: 0 };
  const candidates = ["left", "right"].map((content, index) =>
    Schema.decodeUnknownSync(FilesystemSnapshot)({
      kind: "snapshot-export",
      source: {
        format: "boxes-filesystem-snapshot-v1",
        filesystem: {
          entries: [
            root,
            {
              path: "/value",
              type: "file",
              mode: "0644",
              uid: index + 1,
              gid: index + 10,
              content: Buffer.from(content).toString("base64"),
              encoding: "base64",
            },
          ],
        },
      },
    }),
  );
  const results = await Promise.all(
    candidates.map((snapshot) => post(instance, "/v1/sandboxes", { id: "race", policy, snapshot })),
  );
  expect(results.map((response) => response.status).toSorted()).toEqual([201, 409]);
  const token = Schema.decodeUnknownSync(TokenResponse)(
    await (
      await post(instance, "/v1/sandboxes/race/capabilities", {
        permissions: ["read"],
        expiresInSeconds: 3600,
      })
    ).json(),
  ).token;
  const restored = Schema.decodeUnknownSync(FilesystemSnapshot)(
    await (
      await post(
        instance,
        "/v1/sandboxes/race/action",
        { op: "filesystem.export", maxBytes: 1048576 },
        token,
      )
    ).json(),
  );
  expect(
    candidates.some((candidate) => JSON.stringify(candidate) === JSON.stringify(restored)),
  ).toBe(true);
  await instance.dispose();
  await rm(persisted, { recursive: true, force: true });
});
test("UTF-8 manifest byte quota rejects a snapshot before publishing an unreadable root", async () => {
  const persisted = await mkdtemp(join(tmpdir(), "boxes-import-manifest-limit-"));
  const instance = runtime(persisted, { controlled: false });
  const root = { path: "/", type: "directory", mode: "0755", uid: 0, gid: 0 };
  const entries = [
    root,
    ...Array.from({ length: 2200 }, (_, index) => ({
      ...root,
      path: `/${index}-${"🦀".repeat(970)}`,
    })),
  ];
  expect(
    (
      await post(instance, "/v1/sandboxes", {
        id: "quota",
        policy,
        snapshot: {
          kind: "snapshot-export",
          source: { format: "boxes-filesystem-snapshot-v1", filesystem: { entries } },
        },
      })
    ).status,
  ).toBe(413);
  expect((await (await instance.objects).list({ prefix: "sandboxes/quota/" })).objects).toEqual([]);
  const compact = await post(instance, "/v1/sandboxes", {
    id: "compact",
    policy,
    snapshot: {
      kind: "snapshot-export",
      source: {
        format: "boxes-filesystem-snapshot-v1",
        filesystem: { entries: entries.slice(0, 1201) },
      },
    },
  });
  expect(compact.status).toBe(201);
  expect(Schema.decodeUnknownSync(Status)(await compact.json()).filesystemBytes).toBe(0);
  await instance.dispose();
  await rm(persisted, { recursive: true, force: true });
}, 10000);

test("snapshot content above the old request limit restores multiple chunks and deduplicates repeated blocks", async () => {
  const persisted = await mkdtemp(join(tmpdir(), "boxes-import-blocks-"));
  const instance = runtime(persisted, { controlled: false });
  const bytes = Buffer.alloc(1_048_576, 165);
  const entries = [
    { path: "/", type: "directory", mode: "0755", uid: 0, gid: 0 },
    {
      path: "/large",
      type: "file",
      mode: "0444",
      uid: 0,
      gid: 0,
      content: bytes.toString("base64"),
      encoding: "base64",
    },
  ];
  const created = await post(instance, "/v1/sandboxes", {
    id: "blocks",
    policy,
    snapshot: {
      kind: "snapshot-export",
      source: { format: "boxes-filesystem-snapshot-v1", filesystem: { entries } },
    },
  });
  expect(created.status).toBe(201);
  expect(Schema.decodeUnknownSync(Status)(await created.json()).filesystemBytes).toBe(bytes.length);
  expect(
    (await (await instance.objects).list({ prefix: "sandboxes/blocks/blobs/" })).objects,
  ).toHaveLength(1);
  const token = Schema.decodeUnknownSync(TokenResponse)(
    await (
      await post(instance, "/v1/sandboxes/blocks/capabilities", {
        permissions: ["read"],
        expiresInSeconds: 3600,
      })
    ).json(),
  ).token;
  const contents = Schema.decodeUnknownSync(FileContent)(
    await (
      await post(
        instance,
        "/v1/sandboxes/blocks/action",
        { op: "filesystem.readFile", path: "/large", offset: 262_140, length: 12 },
        token,
      )
    ).json(),
  );
  expect(contents.content).toBe(bytes.subarray(262_140, 262_152).toString("base64"));
  await instance.dispose();
  await rm(persisted, { recursive: true, force: true });
});
