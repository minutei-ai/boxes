import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Schema } from "effect";
import { Action, FileStat, FilesystemSnapshot, TokenResponse, RunRecord } from "../src/contracts";
import { runtime } from "../tooling/worker-test";

test("ownership follows only selected symlinks, preserves file identity and survives Worker replacement", async () => {
  const directory = await mkdtemp(join(tmpdir(), "boxes-ownership-"));
  const first = runtime(directory, { controlled: false });
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
  expect(
    (
      await post(first, "/v1/sandboxes", "cirro-local-test-credential", {
        id: "ownership",
        policy: {
          networkHosts: [],
          interruptBudget: 1000,
          memoryBytes: 8388608,
          maxOutputBytes: 1048576,
        },
      })
    ).status,
  ).toBe(201);
  const path = "/v1/sandboxes/ownership/action";
  const minted = await post(
    first,
    "/v1/sandboxes/ownership/capabilities",
    "cirro-local-test-credential",
    { permissions: ["read", "write", "execute"], expiresInSeconds: 3600 },
  );
  const token = Schema.decodeUnknownSync(TokenResponse)(await minted.json()).token;
  const action = (input: typeof Action.Type) => post(first, path, token, input);
  expect(
    (
      await action({
        op: "filesystem.writeFile",
        path: "/tmp/data",
        content: "retained",
        encoding: "utf8",
      })
    ).status,
  ).toBe(200);
  expect(
    (await action({ op: "filesystem.symlink", path: "/tmp/alias", target: "/tmp/data" })).status,
  ).toBe(200);
  const before = Schema.decodeUnknownSync(FileStat)(
    await (await action({ op: "filesystem.stat", path: "/tmp/data", follow: true })).json(),
  );
  expect(
    (
      await action({
        op: "filesystem.chown",
        path: "/tmp/alias",
        uid: 1000,
        gid: 1001,
        follow: false,
      })
    ).status,
  ).toBe(200);
  const link = Schema.decodeUnknownSync(FileStat)(
    await (await action({ op: "filesystem.stat", path: "/tmp/alias", follow: false })).json(),
  );
  expect([link.uid, link.gid]).toEqual([1000, 1001]);
  const target = Schema.decodeUnknownSync(FileStat)(
    await (await action({ op: "filesystem.stat", path: "/tmp/data", follow: true })).json(),
  );
  expect([target.uid, target.gid, target.inode, target.ctimeNs]).toEqual([
    before.uid,
    before.gid,
    before.inode,
    before.ctimeNs,
  ]);
  const guest = Schema.decodeUnknownSync(RunRecord)(
    await (
      await action({
        op: "process.run",
        id: "chown",
        language: "javascript",
        source:
          'export default async ({ tools }) => tools.call({ op: "filesystem.chown", path: "/tmp/alias", uid: 4294967295, gid: 1002, follow: true })',
      })
    ).json(),
  );
  expect(guest.output?.exitCode).toBe(0);
  const changed = Schema.decodeUnknownSync(FileStat)(
    await (await action({ op: "filesystem.stat", path: "/tmp/data", follow: true })).json(),
  );
  expect([changed.uid, changed.gid, changed.inode, changed.size, changed.mode]).toEqual([
    4294967295,
    1002,
    before.inode,
    before.size,
    before.mode,
  ]);
  expect(BigInt(changed.ctimeNs)).toBeGreaterThanOrEqual(BigInt(before.ctimeNs));
  const readonly = Schema.decodeUnknownSync(TokenResponse)(
    await (
      await post(first, "/v1/sandboxes/ownership/capabilities", "cirro-local-test-credential", {
        permissions: ["read"],
        expiresInSeconds: 3600,
      })
    ).json(),
  ).token;
  expect(
    (
      await post(first, path, readonly, {
        op: "filesystem.chown",
        path: "/tmp/data",
        uid: 1,
        gid: 2,
        follow: true,
      })
    ).status,
  ).toBe(403);
  for (const uid of [-1, 4294967296, 1.5])
    expect(
      (
        await post(first, path, token, {
          op: "filesystem.chown",
          path: "/tmp/data",
          uid,
          gid: 0,
          follow: true,
        })
      ).status,
    ).toBe(400);
  expect(
    (await action({ op: "filesystem.chown", path: "/missing", uid: 1, gid: 2, follow: true }))
      .status,
  ).toBe(404);
  await first.dispose();
  const second = runtime(directory, { controlled: false });
  const restored = Schema.decodeUnknownSync(FileStat)(
    await (
      await post(second, path, token, { op: "filesystem.stat", path: "/tmp/data", follow: true })
    ).json(),
  );
  expect(restored).toEqual(changed);
  const snapshot = Schema.decodeUnknownSync(FilesystemSnapshot)(
    await (await post(second, path, token, { op: "filesystem.export", maxBytes: 1048576 })).json(),
  );
  expect(snapshot.source.filesystem.entries.find((entry) => entry.path === "/tmp/data")?.uid).toBe(
    4294967295,
  );
  expect(snapshot.source.filesystem.entries.find((entry) => entry.path === "/tmp/alias")?.uid).toBe(
    1000,
  );
  await second.dispose();
  await rm(directory, { recursive: true, force: true });
});
