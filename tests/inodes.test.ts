import { expect, test } from "bun:test";
import { Schema } from "effect";
import { initSync, Kernel, migrate_filesystem } from "../dist/kernel/cirro_kernel";
import { FileStat, ReadPlan } from "../src/contracts";

initSync({
  module: new WebAssembly.Module(
    await Bun.file(new URL("../dist/kernel/cirro_kernel_bg.wasm", import.meta.url)).arrayBuffer(),
  ),
});

test("native inode graph shares content and metadata, counts names and preserves aliases after unlink", () => {
  const kernel = new Kernel();
  const stat = (path: string, follow = true) =>
    Schema.decodeUnknownSync(Schema.fromJsonString(FileStat))(kernel.stat(path, follow));
  kernel.write("/tmp/original", 3n, JSON.stringify(["a".repeat(64)]));
  const original = stat("/tmp/original");
  kernel.set_time(100n);
  kernel.link("/tmp/original", "/tmp/alias", false);
  expect(stat("/tmp/alias")).toMatchObject({ inode: original.inode, nlink: 2, ctimeNs: "100" });
  expect(stat("/tmp/original").nlink).toBe(2);
  expect(kernel.bytes()).toBe(3n);
  kernel.chown("/tmp/alias", 123, 456, false);
  kernel.chmod("/tmp/alias", 0o600);
  kernel.write("/tmp/alias", 7n, JSON.stringify(["b".repeat(64)]));
  expect(stat("/tmp/original")).toMatchObject({
    inode: original.inode,
    nlink: 2,
    size: 7,
    mode: 0o600,
    uid: 123,
    gid: 456,
  });
  expect(kernel.chunks("/tmp/original", false)).toBe(kernel.chunks("/tmp/alias", false));
  expect(kernel.bytes()).toBe(7n);
  kernel.rename("/tmp/original", "/tmp/alias");
  expect(stat("/tmp/original").nlink).toBe(2);
  const restored = new Kernel(kernel.manifest());
  expect(
    Schema.decodeUnknownSync(Schema.fromJsonString(FileStat))(restored.stat("/tmp/alias", true)),
  ).toMatchObject({ inode: original.inode, nlink: 2, size: 7 });
  restored.free();
  kernel.set_time(200n);
  kernel.remove("/tmp/original", false);
  expect(stat("/tmp/alias")).toMatchObject({ inode: original.inode, nlink: 1, ctimeNs: "200" });
  kernel.remove("/tmp/alias", false);
  expect(kernel.bytes()).toBe(0n);
  kernel.free();
});

test("native hard links distinguish following symlinks and preserve surviving overwritten inodes", () => {
  const kernel = new Kernel();
  const stat = (path: string, follow = true) =>
    Schema.decodeUnknownSync(Schema.fromJsonString(FileStat))(kernel.stat(path, follow));
  kernel.write("/tmp/target", 0n, "[]");
  kernel.symlink("/tmp/target", "/tmp/symbolic");
  kernel.link("/tmp/symbolic", "/tmp/copied-symbolic", false);
  kernel.link("/tmp/symbolic", "/tmp/followed", true);
  expect(stat("/tmp/symbolic", false).inode).toBe(stat("/tmp/copied-symbolic", false).inode);
  expect(stat("/tmp/symbolic", false).nlink).toBe(2);
  expect(stat("/tmp/target").inode).toBe(stat("/tmp/followed").inode);
  expect(() => kernel.link("/tmp", "/tmp/directory", false)).toThrow("EPERM");
  expect(() => kernel.link("/tmp/absent", "/tmp/missing", false)).toThrow("ENOENT");
  expect(() => kernel.link("/tmp/target", "/tmp/followed", false)).toThrow("EEXIST");
  kernel.write("/tmp/replacement", 1n, JSON.stringify(["c".repeat(64)]));
  const replacement = stat("/tmp/replacement").inode;
  kernel.set_time(300n);
  kernel.rename("/tmp/replacement", "/tmp/target");
  expect(stat("/tmp/target")).toMatchObject({ inode: replacement, nlink: 1 });
  expect(stat("/tmp/followed")).toMatchObject({ nlink: 1, size: 0, ctimeNs: "300" });
  kernel.free();
});

test("explicit migration converts version 3 inode ownership without accepting the old shape at runtime", () => {
  const old = JSON.stringify({
    version: 3,
    generation: 9,
    nextInode: 20,
    packages: [],
    links: {},
    nodes: {
      "/": { kind: "directory", mode: 493 },
      "/file": { kind: "file", mode: 420, size: 0, chunks: [] },
    },
    metadata: {
      "/": { inode: 1, uid: 0, gid: 0, atimeNs: 1, mtimeNs: 2, ctimeNs: 3 },
      "/file": { inode: 7, uid: 123, gid: 456, atimeNs: 4, mtimeNs: 5, ctimeNs: 6 },
    },
  });
  expect(() => new Kernel(old)).toThrow();
  const migrated = migrate_filesystem(old);
  expect(migrate_filesystem(migrated)).toBe(migrated);
  const kernel = new Kernel(migrated);
  kernel.link("/file", "/alias", false);
  expect(
    Schema.decodeUnknownSync(Schema.fromJsonString(FileStat))(kernel.stat("/alias", true)),
  ).toMatchObject({ inode: 7, nlink: 2, uid: 123, gid: 456, atimeNs: "4", mtimeNs: "5" });
  expect(kernel.generation()).toBe(9n);
  kernel.free();
});

test("snapshot reconstruction preserves a migrated root inode and allocation counter", () => {
  const old =
    '{"version":2,"generation":9,"nodes":{"/":{"kind":"directory","mode":493}},"metadata":{"/":{"inode":42,"atimeNs":1,"mtimeNs":2,"ctimeNs":3}},"nextInode":100}';
  const kernel = new Kernel(migrate_filesystem(old));
  kernel.reset_snapshot_root();
  kernel.finish_snapshot_root();
  expect(
    Schema.decodeUnknownSync(Schema.fromJsonString(FileStat))(kernel.stat("/", true)).inode,
  ).toBe(42);
  kernel.write("/after", 0n, "[]");
  expect(
    Schema.decodeUnknownSync(Schema.fromJsonString(FileStat))(kernel.stat("/after", true)).inode,
  ).toBe(100);
  const restored = new Kernel(kernel.manifest());
  restored.free();
  kernel.free();
});

test("opened input and output identities retain authority without changing append-only files", () => {
  const kernel = new Kernel();
  kernel.write("/tmp/file", 3n, JSON.stringify(["a".repeat(64)]));
  kernel.link("/tmp/file", "/tmp/alias", false);
  const initial = Schema.decodeUnknownSync(Schema.fromJsonString(FileStat))(
    kernel.stat("/tmp/file", true),
  );
  const inode = BigInt(initial.inode);
  kernel.chmod("/tmp/file", 0o200);
  const before = kernel.manifest();
  expect(kernel.open_output("/tmp/file", true)).toBe(false);
  expect(kernel.manifest()).toBe(before);
  expect(() => kernel.read_plan("/tmp/file", 0n, 3n, false)).toThrow("EACCES");
  expect(
    Schema.decodeUnknownSync(Schema.fromJsonString(ReadPlan))(
      kernel.read_inode_plan(inode, 0n, 3n),
    ),
  ).toMatchObject({ length: 3, blocks: [{ hash: "a".repeat(64), size: 3 }] });
  expect(kernel.open_output("/tmp/alias", false)).toBe(true);
  expect(
    Schema.decodeUnknownSync(Schema.fromJsonString(FileStat))(kernel.stat("/tmp/file", true)),
  ).toMatchObject({ inode: initial.inode, size: 0, mode: 0o200, nlink: 2 });
  expect(kernel.open_output("/tmp/new", true)).toBe(true);
  kernel.chmod("/tmp/file", 0o400);
  expect(() => kernel.open_output("/tmp/file", true)).toThrow("EACCES");
  kernel.free();
});
