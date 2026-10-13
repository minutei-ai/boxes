import { expect, test } from "bun:test";
import { Schema } from "effect";
import { join } from "node:path";
import { initSync, prepare_package, migrate_filesystem, Kernel } from "../dist/kernel/cirro_kernel";
import { PackagePreparation, FileStat } from "../src/contracts";

initSync({
  module: new WebAssembly.Module(
    await Bun.file(join(import.meta.dir, "../dist/kernel/cirro_kernel_bg.wasm")).arrayBuffer(),
  ),
});

const identity = Buffer.concat([
  Buffer.from([4]),
  Buffer.from("echo"),
  Buffer.from([5]),
  Buffer.from("1.0.0"),
]);
const packageBytes = (manifest: Uint8Array, index: Uint8Array) => {
  const header = Buffer.from([0x89, 65, 79, 83, 2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
  header.writeUInt32LE(manifest.byteLength + 2, 8);
  header.writeUInt32LE(index.byteLength + 2, 12);
  return Buffer.concat([
    header,
    Buffer.from([2, 0]),
    manifest,
    Buffer.from([2, 0]),
    index,
    Buffer.alloc(1024),
  ]);
};

test("compiled wasm32 package decoder exposes its validated plan through the concrete host Schema", async () => {
  const bytes = packageBytes(Buffer.concat([identity, Buffer.from([0, 0, 0])]), Buffer.from([0]));
  const plan = Schema.decodeUnknownSync(Schema.fromJsonString(PackagePreparation), {
    onExcessProperty: "error",
  })(prepare_package(bytes));
  expect(plan.root).toBe("/opt/cirro/pkgs/echo/1.0.0");
  expect(plan.entries).toEqual([]);
  expect(plan.blocks).toEqual([]);
  const digest = Buffer.from(await crypto.subtle.digest("SHA-256", bytes)).toString("hex");
  expect(plan.installed.packageId).toBe(digest);
  expect(plan.installed.digest).toBe(`sha256:${digest}`);
  expect(plan.installed.sizeBytes).toBe(bytes.length);
});

test("compiled wasm32 decoder rejects overflowing BARE lengths instead of accepting wrapped strings and inventories", () => {
  const overflow = Buffer.from([128, 128, 128, 128, 16]);
  const value = Buffer.concat([
    identity,
    Buffer.from([1, 1, 4]),
    Buffer.from("MODE"),
    overflow,
    Buffer.from([0, 0, 0]),
  ]);
  expect(() => prepare_package(packageBytes(value, Buffer.from([0])))).toThrow();
  expect(() =>
    prepare_package(packageBytes(Buffer.concat([identity, Buffer.from([0, 0, 0])]), overflow)),
  ).toThrow();
});

test("compiled wasm32 decoder rejects duplicate environment keys and trailing metadata", () => {
  const duplicate = Buffer.concat([
    identity,
    Buffer.from([1, 2, 4]),
    Buffer.from("MODE"),
    Buffer.from([1, 97, 4]),
    Buffer.from("MODE"),
    Buffer.from([1, 98, 0, 0, 0]),
  ]);
  expect(() => prepare_package(packageBytes(duplicate, Buffer.from([0])))).toThrow();
  expect(() =>
    prepare_package(
      packageBytes(Buffer.concat([identity, Buffer.from([0, 0, 0, 0])]), Buffer.from([0])),
    ),
  ).toThrow();
});

test("filesystem migration preserves version 2 identities and precise historical timestamps and seeds an empty catalog", () => {
  const old =
    '{"version":2,"generation":9,"nodes":{"/":{"kind":"directory","mode":493}},"metadata":{"/":{"inode":42,"atimeNs":1000000000000000001,"mtimeNs":1000000000000000003,"ctimeNs":1000000000000000005}},"nextInode":100}';
  const migrated = migrate_filesystem(old);
  const kernel = new Kernel(migrated);
  const stat = Schema.decodeUnknownSync(Schema.fromJsonString(FileStat))(kernel.stat("/", true));
  expect(stat.inode).toBe(42);
  expect(stat.uid).toBe(0);
  expect(stat.gid).toBe(0);
  expect(stat.atimeNs).toBe("1000000000000000001");
  expect(stat.mtimeNs).toBe("1000000000000000003");
  expect(stat.ctimeNs).toBe("1000000000000000005");
  expect(kernel.packages()).toBe("[]");
  expect(kernel.generation()).toBe(9n);
  expect(migrate_filesystem(migrated)).toBe(migrated);
  kernel.free();
});

test("native snapshot rollback preserves inode identities and package catalog while rejecting malformed snapshots", () => {
  const kernel = new Kernel();
  const initial = kernel.manifest();
  const root = Schema.decodeUnknownSync(Schema.fromJsonString(FileStat))(kernel.stat("/", true));
  kernel.mkdir("/tmp/transient", false);
  kernel.advance();
  expect(kernel.manifest()).not.toBe(initial);
  kernel.restore_manifest(initial);
  expect(kernel.manifest()).toBe(initial);
  expect(
    Schema.decodeUnknownSync(Schema.fromJsonString(FileStat))(kernel.stat("/", true)).inode,
  ).toBe(root.inode);
  expect(() => kernel.restore_manifest("{}")).toThrow();
  expect(kernel.manifest()).toBe(initial);
  kernel.free();
});

test("anonymous inode allocation leaves directory metadata and persistent nodes unchanged", () => {
  const kernel = new Kernel();
  kernel.set_time(1000n);
  const before = Schema.decodeUnknownSync(Schema.fromJsonString(FileStat))(
    kernel.stat("/tmp", true),
  );
  const count = kernel.node_count();
  const first = Schema.decodeUnknownSync(Schema.fromJsonString(FileStat))(
    kernel.temporary_file("/tmp", 0o600),
  );
  const second = Schema.decodeUnknownSync(Schema.fromJsonString(FileStat))(
    kernel.temporary_file("/tmp", 0o600),
  );
  const after = Schema.decodeUnknownSync(Schema.fromJsonString(FileStat))(
    kernel.stat("/tmp", true),
  );
  expect(first.nlink).toBe(0);
  expect(first.size).toBe(0);
  expect(first.mode).toBe(0o600);
  expect(first.inode).not.toBe(second.inode);
  expect(first.mtimeNs).toBe("1000");
  expect(after).toEqual(before);
  expect(kernel.node_count()).toBe(count);
  const restored = new Kernel(kernel.manifest());
  const third = Schema.decodeUnknownSync(Schema.fromJsonString(FileStat))(
    restored.temporary_file("/tmp", 0o600),
  );
  expect(third.inode).toBeGreaterThan(second.inode);
  restored.free();
  kernel.free();
});
