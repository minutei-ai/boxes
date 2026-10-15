import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Redacted, Schema } from "effect";
import { FetchHttpClient } from "effect/http";
import { initSync, Kernel } from "../dist/kernel/cirro_kernel";
import { FileStat, FilesystemSnapshot, Head } from "../src/contracts";
import { make } from "../src/sdk";
import { runtime } from "../tooling/worker-test";

initSync({
  module: new WebAssembly.Module(
    await Bun.file(new URL("../dist/kernel/cirro_kernel_bg.wasm", import.meta.url)).arrayBuffer(),
  ),
});

test("bulk snapshot metadata matches scalar stat for directories, aliases and dangling symlinks", () => {
  const kernel = new Kernel();
  kernel.mkdir("/tmp/nested", false);
  kernel.mkdir("/tmp/nested/empty", false);
  kernel.write("/tmp/nested/file", 0n, "[]");
  kernel.link("/tmp/nested/file", "/tmp/alias", false);
  kernel.symlink("/absent", "/tmp/symbolic");
  kernel.link("/tmp/symbolic", "/tmp/symbolic-alias", false);
  kernel.chown("/tmp/alias", 123, 456, false);
  kernel.set_times("/tmp/alias", false, 111n, 222n, 5);
  const metadata = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Array(FileStat)))(
    kernel.snapshot_metadata(),
  );
  for (const stat of metadata)
    expect(stat).toEqual(
      Schema.decodeUnknownSync(Schema.fromJsonString(FileStat))(kernel.stat(stat.path, false)),
    );
  expect(metadata.find((stat) => stat.path === "/tmp")?.nlink).toBe(3);
  kernel.chmod("/tmp/nested", 0);
  expect(() => kernel.snapshot_metadata()).toThrow("EACCES");
  kernel.chmod("/tmp/nested", 0o700);
  kernel.chmod("/", 0o100);
  expect(() => kernel.snapshot_metadata()).toThrow("EACCES");
  kernel.free();
});

test(
  "native Worker exports the full unique-inode limit with exact byte bounds and scoped read authority",
  () =>
    Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const directory = yield* Effect.acquireRelease(
            Effect.promise(() => mkdtemp(join(tmpdir(), "boxes-metadata-"))),
            (path) => Effect.promise(() => rm(path, { recursive: true, force: true })),
          );
          const worker = yield* Effect.acquireRelease(
            Effect.sync(() => runtime(directory)),
            (worker) => Effect.promise(() => worker.dispose()),
          );
          const kernel = yield* Effect.acquireRelease(
            Effect.sync(() => new Kernel()),
            (kernel) => Effect.sync(() => kernel.free()),
          );
          for (const index of Array.from({ length: 16380 }, (_, index) => index))
            kernel.write(`/tmp/f${index.toString().padStart(5, "0")}`, 0n, "[]");
          expect(kernel.node_count()).toBe(16384);
          const url = (yield* Effect.promise(() => worker.ready)).toString();
          const admin = yield* make({ url, token: Redacted.make("cirro-local-test-credential") });
          yield* admin.create({
            id: "metadata",
            policy: {
              networkHosts: [],
              interruptBudget: 1000,
              memoryBytes: 8388608,
              maxOutputBytes: 1048576,
            },
          });
          const bucket = yield* Effect.promise(() => worker.objects);
          const key = "sandboxes/metadata/head.json";
          const root = yield* Effect.promise(() => bucket.get(key));
          if (root === null) return yield* Effect.die("Missing sandbox head");
          const head = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Head))(
            yield* Effect.promise(() => root.text()),
          );
          yield* Effect.promise(() =>
            bucket.put(
              key,
              Schema.encodeSync(Schema.fromJsonString(Head))({
                ...head,
                manifest: kernel.manifest(),
              }),
            ),
          );
          const grant = yield* admin.mintCapability("metadata", {
            permissions: ["read"],
            expiresInSeconds: 600,
          });
          const reader = yield* make({ url, token: Redacted.make(grant.token) });
          const snapshot = yield* reader.action("metadata", {
            op: "filesystem.export",
            maxBytes: 8388608,
          });
          expect(snapshot.source.filesystem.entries).toHaveLength(16384);
          expect(
            snapshot.source.filesystem.entries.filter((entry) => entry.type === "file"),
          ).toHaveLength(16380);
          const size = Buffer.byteLength(
            Schema.encodeSync(Schema.fromJsonString(FilesystemSnapshot))(snapshot),
          );
          expect(
            yield* reader
              .action("metadata", { op: "filesystem.export", maxBytes: size - 1 })
              .pipe(Effect.flip),
          ).toMatchObject({ error: "EFBIG", status: 413 });
          const denied = yield* admin.mintCapability("metadata", {
            permissions: ["write"],
            expiresInSeconds: 600,
          });
          const writer = yield* make({ url, token: Redacted.make(denied.token) });
          expect(
            yield* writer
              .action("metadata", { op: "filesystem.export", maxBytes: 8388608 })
              .pipe(Effect.flip),
          ).toMatchObject({ error: "FORBIDDEN", status: 403 });
        }),
      ).pipe(Effect.provide(FetchHttpClient.layer)),
    ),
  30000,
);
