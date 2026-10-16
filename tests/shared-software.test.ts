import { defaultSoftware } from "../src/default-software";
import { expect, test } from "bun:test";
import { Effect, Schema } from "effect";
import { initSync, Kernel, migrate_filesystem } from "../dist/kernel/cirro_kernel";
import { FileStat, ReadPlan, RangeWritePlan, PackageInstallation } from "../src/contracts";
import { downloadSoftware } from "../tooling/software-artifacts";
import { prepareSoftwareBase } from "../tooling/software-base";

initSync({
  module: new WebAssembly.Module(
    await Bun.file(new URL("../dist/kernel/cirro_kernel_bg.wasm", import.meta.url)).arrayBuffer(),
  ),
});

test("software preparation rejects an empty catalog and stale kernel identity before publication", async () => {
  const empty = await Effect.runPromise(
    prepareSoftwareBase({ kernelDigest: "0".repeat(64), artifacts: [] }).pipe(Effect.result),
  );
  expect(empty._tag).toBe("Failure");
  if (empty._tag === "Failure") expect(empty.failure._tag).toBe("SchemaError");
  const stale = await Effect.runPromise(
    prepareSoftwareBase({ kernelDigest: "0".repeat(64), artifacts: defaultSoftware }).pipe(
      Effect.result,
    ),
  );
  expect(stale._tag).toBe("Failure");
  if (stale._tag === "Failure") expect(stale.failure._tag).toBe("SoftwareBaseFailure");
});

test("native public software provenance survives copies, uninstall and restoration while private writes stay private", async () => {
  const bytes = await Effect.runPromise(downloadSoftware(defaultSoftware[0]));
  const kernel = new Kernel();
  kernel.install_package(bytes);
  const executable = "/opt/cirro/pkgs/sh/0.17.0/bin/sh";
  const read = (kernel: Kernel, path: string) =>
    Schema.decodeUnknownSync(Schema.fromJsonString(ReadPlan))(
      kernel.read_plan(path, 0n, 16_777_216n, false),
    );
  expect(read(kernel, executable).blocks.every((block) => !block.shared)).toBe(true);
  kernel.share_package_blocks();
  const shared = read(kernel, executable);
  expect(shared.blocks.length).toBeGreaterThan(1);
  expect(shared.blocks.every((block) => block.shared)).toBe(true);
  expect(kernel.write("/tmp/copied", BigInt(shared.length), kernel.chunks(executable, false))).toBe(
    "[]",
  );
  expect(() => kernel.install_package(bytes)).toThrow("EEXIST");
  kernel.write("/tmp/private", 3n, JSON.stringify(["a".repeat(64)]));
  expect(read(kernel, "/tmp/private").blocks.every((block) => !block.shared)).toBe(true);
  kernel.uninstall_package(defaultSoftware[0].digest);
  expect(
    Schema.decodeUnknownSync(Schema.fromJsonString(PackageInstallation))(
      kernel.install_package(bytes),
    ).blocks,
  ).toEqual([]);
  kernel.uninstall_package(defaultSoftware[0].digest);
  const restored = new Kernel(kernel.manifest());
  expect(read(restored, "/tmp/copied")).toEqual(shared);
  const patch = Schema.decodeUnknownSync(Schema.fromJsonString(RangeWritePlan))(
    restored.write_range_plan("/tmp/copied", 0n, 1n),
  );
  expect(patch.blocks[0]?.previous?.shared).toBe(true);
  restored.write("/tmp/copied", 3n, JSON.stringify(["b".repeat(64)]));
  expect(read(restored, "/tmp/copied").blocks.every((block) => !block.shared)).toBe(true);
  restored.reset_snapshot_root();
  restored.finish_snapshot_root();
  expect(restored.manifest()).toContain('"sharedChunks":[]');
  restored.free();
  kernel.free();
}, 20000);

test("explicit v4 migration preserves inode aliases and private provenance without accepting v4 in the request runtime", () => {
  const prior = `{"version":4,"generation":9,"nodes":{"/":1,"/file":7,"/alias":7},"inodes":{"1":{"node":{"kind":"directory","mode":493},"metadata":{"inode":1,"uid":0,"gid":0,"atimeNs":1,"mtimeNs":2,"ctimeNs":3}},"7":{"node":{"kind":"file","mode":420,"size":3,"chunks":["${"a".repeat(64)}"]},"metadata":{"inode":7,"uid":123,"gid":456,"atimeNs":4,"mtimeNs":5,"ctimeNs":6}}},"nextInode":20,"packages":[],"links":{}}`;
  expect(() => new Kernel(prior)).toThrow();
  const migrated = migrate_filesystem(prior);
  expect(migrate_filesystem(migrated)).toBe(migrated);
  const kernel = new Kernel(migrated);
  expect(kernel.generation()).toBe(9n);
  expect(
    Schema.decodeUnknownSync(Schema.fromJsonString(FileStat))(kernel.stat("/alias", true)),
  ).toMatchObject({ inode: 7, nlink: 2, uid: 123, gid: 456, atimeNs: "4", mtimeNs: "5" });
  expect(
    Schema.decodeUnknownSync(Schema.fromJsonString(ReadPlan))(
      kernel.read_plan("/alias", 0n, 3n, false),
    ).blocks,
  ).toEqual([{ hash: "a".repeat(64), size: 3, shared: false }]);
  expect(
    () => new Kernel(migrated.replace('"sharedChunks":[]', '"sharedChunks":["invalid"]')),
  ).toThrow();
  kernel.free();
});

test("a full private quota still permits an unchanged public block while final hashes reject new private content", async () => {
  const bytes = await Effect.runPromise(downloadSoftware(defaultSoftware[0]));
  const kernel = new Kernel();
  kernel.install_image_package(bytes);
  const executable = "/opt/cirro/pkgs/sh/0.17.0/bin/sh";
  const plan = Schema.decodeUnknownSync(Schema.fromJsonString(ReadPlan))(
    kernel.read_plan(executable, 0n, 16_777_216n, false),
  );
  const shared = kernel.chunks(executable, false);
  kernel.write("/tmp/public-copy", BigInt(plan.length), shared);
  const privateChunks = JSON.stringify(Array.from({ length: 64 }, () => "b".repeat(64)));
  for (const name of ["a", "b", "c", "d"]) kernel.write(`/tmp/${name}`, 16_777_216n, privateChunks);
  const range = Schema.decodeUnknownSync(Schema.fromJsonString(RangeWritePlan))(
    kernel.write_range_plan("/tmp/public-copy", 0n, 1n),
  );
  expect(range.blocks).toHaveLength(1);
  expect(range.blocks[0]?.previous?.shared).toBe(true);
  expect(kernel.prepare_write("/tmp/public-copy", BigInt(plan.length), shared)).toBe("[]");
  const changed = plan.blocks.map((block, index) => {
    if (index === 0) return "b".repeat(64);
    return block.hash;
  });
  expect(() =>
    kernel.prepare_write("/tmp/public-copy", BigInt(plan.length), JSON.stringify(changed)),
  ).toThrow("ENOSPC");
  kernel.write(
    "/tmp/d",
    16_515_072n,
    JSON.stringify(Array.from({ length: 63 }, () => "b".repeat(64))),
  );
  expect(
    kernel.prepare_write("/tmp/public-copy", BigInt(plan.length), JSON.stringify(changed)),
  ).toBe(JSON.stringify(["b".repeat(64)]));
  kernel.free();
});
