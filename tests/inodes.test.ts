import { expect, test } from "bun:test";
import { Schema } from "effect";
import { initSync, Kernel, migrate_filesystem } from "../dist/kernel/cirro_kernel";
import { FileStat, ReadPlan, RangeWritePlan } from "../src/contracts";

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

test("append planning distinguishes EOF from positional zero and excludes unchanged prefix blocks", () => {
  const kernel = new Kernel();
  const hash = "a".repeat(64);
  kernel.write("/tmp/file", 1048576n, JSON.stringify([hash, hash, hash, hash]));
  const append = Schema.decodeUnknownSync(Schema.fromJsonString(RangeWritePlan))(
    kernel.write_range_plan("/tmp/file", undefined, 1n),
  );
  expect(append).toMatchObject({
    offset: 1048576,
    size: 1048577,
    changed: true,
    blocks: [{ index: 4, size: 1, previous: null }],
  });
  expect(append.chunks.slice(0, 4)).toEqual([hash, hash, hash, hash]);
  const positioned = Schema.decodeUnknownSync(Schema.fromJsonString(RangeWritePlan))(
    kernel.write_range_plan("/tmp/file", 0n, 1n),
  );
  expect(positioned.offset).toBe(0);
  expect(positioned.size).toBe(1048576);
  expect(positioned.blocks.map((block) => block.index)).toEqual([0]);
  expect(
    Schema.decodeUnknownSync(Schema.fromJsonString(RangeWritePlan))(
      kernel.write_range_plan("/tmp/file", undefined, 0n),
    ).changed,
  ).toBe(false);
  expect(
    Schema.decodeUnknownSync(Schema.fromJsonString(RangeWritePlan))(
      kernel.write_range_plan("/tmp/file", BigInt(Number.MAX_SAFE_INTEGER), 0n),
    ),
  ).toMatchObject({ offset: Number.MAX_SAFE_INTEGER, size: 1048576, changed: false });
  expect(
    Schema.decodeUnknownSync(Schema.fromJsonString(RangeWritePlan))(
      kernel.write_range_plan("/tmp/missing", undefined, 0n),
    ),
  ).toMatchObject({ offset: 0, size: 0, changed: true });
  kernel.free();
});

test("resize plans preserve prefix references, bound tail I/O and reject invalid targets before mutation", () => {
  const kernel = new Kernel();
  const first = "a".repeat(64);
  const tail = "b".repeat(64);
  kernel.write("/tmp/file", 786463n, JSON.stringify([first, first, first, tail]));
  const before = kernel.manifest();
  const aligned = Schema.decodeUnknownSync(Schema.fromJsonString(RangeWritePlan))(
    kernel.resize_plan("/tmp/file", 262144n),
  );
  expect(aligned).toMatchObject({
    offset: 0,
    size: 262144,
    changed: true,
    chunks: [first],
    blocks: [],
  });
  const partial = Schema.decodeUnknownSync(Schema.fromJsonString(RangeWritePlan))(
    kernel.resize_plan("/tmp/file", 262153n),
  );
  expect(partial.blocks).toEqual([{ index: 1, size: 9, previous: { hash: first, size: 262144 } }]);
  const grown = Schema.decodeUnknownSync(Schema.fromJsonString(RangeWritePlan))(
    kernel.resize_plan("/tmp/file", 1048581n),
  );
  expect(grown.blocks).toEqual([
    { index: 3, size: 262144, previous: { hash: tail, size: 31 } },
    { index: 4, size: 5, previous: null },
  ]);
  expect(
    Schema.decodeUnknownSync(Schema.fromJsonString(RangeWritePlan))(
      kernel.resize_plan("/tmp/file", 786463n),
    ),
  ).toMatchObject({ changed: true, blocks: [] });
  expect(kernel.manifest()).toBe(before);
  expect(() => kernel.resize_plan("/tmp/missing", 0n)).toThrow("ENOENT");
  expect(() => kernel.resize_plan("/tmp", 0n)).toThrow("EISDIR");
  expect(() => kernel.resize_plan("/tmp/file", 16777217n)).toThrow("EFBIG");
  kernel.chmod("/tmp/file", 0o400);
  expect(() => kernel.resize_plan("/tmp/file", 1n)).toThrow("EACCES");
  kernel.free();
  const full = new Kernel();
  for (const name of ["a", "b", "c"])
    full.write(`/tmp/${name}`, 16777216n, JSON.stringify(Array.from({ length: 64 }, () => first)));
  for (const name of ["d", "e"])
    full.write(`/tmp/${name}`, 8388608n, JSON.stringify(Array.from({ length: 32 }, () => first)));
  const manifest = full.manifest();
  expect(() => full.resize_plan("/tmp/d", 8388609n)).toThrow("ENOSPC");
  expect(full.manifest()).toBe(manifest);
  full.free();
});
