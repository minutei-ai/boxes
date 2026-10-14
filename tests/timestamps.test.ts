import { afterAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Layer, Redacted } from "effect";
import { FetchHttpClient } from "effect/http";
import { make } from "../src/sdk";
import { runtime } from "../tooling/worker-test";

const directory = await mkdtemp(join(tmpdir(), "boxes-timestamps-"));
const first = runtime(directory, { controlled: false });
const instances = [first];
const transport = FetchHttpClient.layer.pipe(
  Layer.provide(Layer.succeed(FetchHttpClient.RequestInit, { keepalive: false })),
);
const run = <A, E>(program: Effect.Effect<A, E, import("effect/http/HttpClient").HttpClient>) =>
  Effect.runPromise(program.pipe(Effect.provide(transport)));
afterAll(async () => {
  for (const instance of instances) await instance.dispose();
  await rm(directory, { recursive: true, force: true });
});
test("timestamp API preserves exact uint64 values, symlink selection, grants and persistence", async () => {
  const admin = await run(
    make({
      url: (await first.ready).toString(),
      token: Redacted.make("cirro-local-test-credential"),
    }),
  );
  await run(
    admin.create({
      id: "times",
      policy: {
        networkHosts: [],
        interruptBudget: 1000,
        memoryBytes: 8388608,
        maxOutputBytes: 1048576,
      },
    }),
  );
  const grant = await run(
    admin.mintCapability("times", {
      permissions: ["read", "write", "execute"],
      expiresInSeconds: 3600,
    }),
  );
  const boxes = await run(
    make({ url: (await first.ready).toString(), token: Redacted.make(grant.token) }),
  );
  await run(
    boxes.action("times", {
      op: "filesystem.writeFile",
      path: "/tmp/data",
      content: "retained",
      encoding: "utf8",
    }),
  );
  await run(
    boxes.action("times", { op: "filesystem.symlink", path: "/tmp/alias", target: "data" }),
  );
  const before = await run(
    boxes.action("times", { op: "filesystem.stat", path: "/tmp/data", follow: true }),
  );
  expect(
    (
      await run(
        boxes.action("times", {
          op: "filesystem.utimes",
          path: "/tmp/alias",
          atimeNs: 0n,
          mtimeNs: 18446744073709551615n,
          follow: false,
        }),
      )
    ).ok,
  ).toBe(true);
  const link = await run(
    boxes.action("times", { op: "filesystem.stat", path: "/tmp/alias", follow: false }),
  );
  expect([link.atimeNs, link.mtimeNs]).toEqual(["0", "18446744073709551615"]);
  expect(
    await run(boxes.action("times", { op: "filesystem.stat", path: "/tmp/data", follow: true })),
  ).toEqual(before);
  const guest = await run(
    boxes.action("times", {
      op: "process.run",
      language: "typescript",
      id: "guest-times",
      source:
        'export default async ({ tools }) => tools.call({ op: "filesystem.utimes", path: "/tmp/alias", atimeNs: "9007199254740993", mtimeNs: "1234567890123456789", follow: true })',
    }),
  );
  expect(guest.status).toBe("exited");
  expect(guest.output?.result).toEqual({ ok: true });
  const changed = await run(
    boxes.action("times", { op: "filesystem.stat", path: "/tmp/data", follow: true }),
  );
  expect([changed.atimeNs, changed.mtimeNs]).toEqual(["9007199254740993", "1234567890123456789"]);
  expect([changed.inode, changed.size, changed.mode, changed.uid, changed.gid]).toEqual([
    before.inode,
    before.size,
    before.mode,
    before.uid,
    before.gid,
  ]);
  expect(BigInt(changed.ctimeNs)).toBeGreaterThanOrEqual(BigInt(before.ctimeNs));
  const readonly = await run(
    admin.mintCapability("times", { permissions: ["read"], expiresInSeconds: 600 }),
  );
  const reader = await run(
    make({ url: (await first.ready).toString(), token: Redacted.make(readonly.token) }),
  );
  expect(
    await run(
      reader
        .action("times", {
          op: "filesystem.utimes",
          path: "/tmp/data",
          atimeNs: 0n,
          mtimeNs: 0n,
          follow: true,
        })
        .pipe(Effect.flip),
    ),
  ).toMatchObject({ _tag: "BoxesError", status: 403 });
  const generation = (await run(boxes.action("times", { op: "vm.status" }))).generation;
  for (const atimeNs of [
    "-1",
    "18446744073709551616",
    "1.5",
    "bad",
    "0001",
    "+1",
    "0x1",
    "1".repeat(1024),
    1,
  ]) {
    const invalid = await fetch(new URL("/v1/sandboxes/times/action", await first.ready), {
      method: "POST",
      keepalive: false,
      headers: { authorization: `Bearer ${grant.token}`, "content-type": "application/json" },
      body: JSON.stringify({
        op: "filesystem.utimes",
        path: "/tmp/data",
        atimeNs,
        mtimeNs: "0",
        follow: true,
      }),
    });
    expect(invalid.status).toBe(400);
  }
  expect((await run(boxes.action("times", { op: "vm.status" }))).generation).toBe(generation);
  expect(
    await run(
      boxes
        .action("times", {
          op: "filesystem.utimes",
          path: "/missing",
          atimeNs: 0n,
          mtimeNs: 0n,
          follow: true,
        })
        .pipe(Effect.flip),
    ),
  ).toMatchObject({ _tag: "BoxesError", status: 404 });
  await first.dispose();
  const second = runtime(directory, { controlled: false });
  instances.splice(0, 1, second);
  const restored = await run(
    make({ url: (await second.ready).toString(), token: Redacted.make(grant.token) }),
  );
  expect(
    await run(restored.action("times", { op: "filesystem.stat", path: "/tmp/data", follow: true })),
  ).toEqual(changed);
  const file = await run(
    restored.action("times", { op: "filesystem.readFile", path: "/tmp/data" }),
  );
  expect(Buffer.from(file.content, file.encoding).toString()).toBe("retained");
}, 15000);
