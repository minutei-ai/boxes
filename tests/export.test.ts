import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Schema } from "effect";
import { FilesystemSnapshot, TokenResponse, ErrorResponse, RunRecord } from "../src/contracts";
import { runtime } from "../tooling/runtime";

test("root exports retain binary files, modes and symlinks with exact byte limits across Worker replacement", async () => {
  const directory = await mkdtemp(join(tmpdir(), "boxes-export-"));
  const first = runtime(directory);
  const post = async (path: string, token: string, body: unknown) =>
    fetch(new URL(path, await first.ready), {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  expect(
    (
      await post("/v1/sandboxes", "cirro-local-test-credential", {
        id: "export",
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
      await post("/v1/sandboxes/export/capabilities", "cirro-local-test-credential", {
        permissions: ["read", "write", "execute"],
        expiresInSeconds: 3600,
      })
    ).json(),
  ).token;
  const path = "/v1/sandboxes/export/action";
  const binary = Buffer.from([0, 255, 128, 10, 0, 1]).toString("base64");
  expect(
    (
      await post(path, token, {
        op: "filesystem.writeFile",
        path: "/tmp/data",
        content: binary,
        encoding: "base64",
      })
    ).status,
  ).toBe(200);
  expect(
    (await post(path, token, { op: "filesystem.chmod", path: "/tmp/data", mode: 416 })).status,
  ).toBe(200);
  for (const [link, target] of [
    ["/tmp/relative", "data"],
    ["/tmp/dangling", "missing"],
    ["/tmp/cycle", "cycle"],
  ]) {
    expect((await post(path, token, { op: "filesystem.symlink", path: link, target })).status).toBe(
      200,
    );
  }
  const bucket = await first.getR2Bucket("OBJECTS");
  const before = await bucket.head("sandboxes/export/head.json");
  const response = await post(path, token, { op: "filesystem.export", maxBytes: 25165824 });
  expect(response.status).toBe(200);
  const bytes = await response.text();
  const snapshot = Schema.decodeUnknownSync(Schema.fromJsonString(FilesystemSnapshot))(bytes);
  expect(snapshot.source.filesystem.entries.find((entry) => entry.path === "/tmp/data")).toEqual({
    path: "/tmp/data",
    type: "file",
    mode: "0640",
    uid: 0,
    gid: 0,
    content: binary,
    encoding: "base64",
  });
  expect(
    snapshot.source.filesystem.entries.find((entry) => entry.path === "/tmp/cycle"),
  ).toMatchObject({ type: "symlink", target: "cycle" });
  expect(
    snapshot.source.filesystem.entries.find((entry) => entry.path === "/tmp/dangling"),
  ).toMatchObject({ type: "symlink", target: "missing" });
  expect(snapshot.source.filesystem.entries[0]?.path).toBe("/");
  expect(
    (await post(path, token, { op: "filesystem.export", maxBytes: Buffer.byteLength(bytes) }))
      .status,
  ).toBe(200);
  const limited = await post(path, token, {
    op: "filesystem.export",
    maxBytes: Buffer.byteLength(bytes) - 1,
  });
  expect(limited.status).toBe(413);
  expect(Schema.decodeUnknownSync(ErrorResponse)(await limited.json()).error).toBe("EFBIG");
  const guest = await post(path, token, {
    op: "process.run",
    id: "export-guest",
    language: "javascript",
    source: `export default async ({tools}) => { const snapshot = await tools.call({op: "filesystem.export", maxBytes: 25165824}); return snapshot.source.filesystem.entries.find(entry => entry.path === "/tmp/data").content; };`,
  });
  expect(guest.status).toBe(200);
  expect(Schema.decodeUnknownSync(RunRecord)(await guest.json()).output?.result).toBe(binary);
  expect((await bucket.head("sandboxes/export/head.json"))?.etag).toBe(before?.etag);
  const writeToken = Schema.decodeUnknownSync(TokenResponse)(
    await (
      await post("/v1/sandboxes/export/capabilities", "cirro-local-test-credential", {
        permissions: ["write"],
        expiresInSeconds: 3600,
      })
    ).json(),
  ).token;
  expect(
    (await post(path, writeToken, { op: "filesystem.export", maxBytes: 25165824 })).status,
  ).toBe(403);
  expect(
    (
      await post("/v1/sandboxes/another/action", token, {
        op: "filesystem.export",
        maxBytes: 25165824,
      })
    ).status,
  ).toBe(401);
  expect((await post(path, token, { op: "filesystem.export", maxBytes: 0 })).status).toBe(400);
  await first.dispose();
  const second = runtime(directory);
  const restored = await fetch(new URL(path, await second.ready), {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ op: "filesystem.export", maxBytes: 25165824 }),
  });
  expect(restored.status).toBe(200);
  expect(await restored.text()).toBe(bytes);
  const action = async (body: unknown) =>
    fetch(new URL(path, await second.ready), {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  const pair = (value: string) => ({
    op: "filesystem.writeFiles",
    entries: ["/tmp/left", "/tmp/right"].map((file) => ({
      path: file,
      content: value.repeat(262144),
      encoding: "utf8",
    })),
  });
  expect((await action(pair("a"))).status).toBe(200);
  for (const value of ["b", "c", "d"]) {
    const [mutation, exported] = await Promise.all([
      action(pair(value)),
      action({ op: "filesystem.export", maxBytes: 25165824 }),
    ]);
    expect(mutation.status).toBe(200);
    expect(exported.status).toBe(200);
    const captured = Schema.decodeUnknownSync(FilesystemSnapshot)(await exported.json());
    const left = captured.source.filesystem.entries.find((entry) => entry.path === "/tmp/left");
    const right = captured.source.filesystem.entries.find((entry) => entry.path === "/tmp/right");
    expect(left?.type).toBe("file");
    expect(right?.type).toBe("file");
    if (left?.type === "file" && right?.type === "file") expect(left.content).toBe(right.content);
  }
  expect((await action({ op: "filesystem.chmod", path: "/tmp/data", mode: 0 })).status).toBe(200);
  expect((await action({ op: "filesystem.export", maxBytes: 25165824 })).status).toBe(403);
  expect((await action({ op: "filesystem.chmod", path: "/tmp/data", mode: 416 })).status).toBe(200);
  const digest = new Bun.CryptoHasher("sha256").update(Buffer.from(binary, "base64")).digest("hex");
  await (
    await second.getR2Bucket("OBJECTS")
  ).put(`sandboxes/export/blobs/${digest}`, Buffer.from([0, 255, 128, 11, 0, 1]));
  const corrupt = await action({ op: "filesystem.export", maxBytes: 25165824 });
  expect(corrupt.status).toBe(500);
  expect(Schema.decodeUnknownSync(ErrorResponse)(await corrupt.json()).error).toBe("EIO");
  await second.dispose();
  await rm(directory, { recursive: true, force: true });
});
