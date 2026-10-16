import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Schema } from "effect";
import { initSync, prepare_package } from "../dist/kernel/cirro_kernel";
import { PackagePreparation } from "../src/contracts";

initSync({
  module: new WebAssembly.Module(
    await Bun.file(join(import.meta.dir, "../dist/kernel/cirro_kernel_bg.wasm")).arrayBuffer(),
  ),
});

test("native guest packer produces deterministic kernel-admitted files and rejects unsafe notices", () =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const directory = yield* Effect.acquireRelease(
          Effect.promise(() => mkdtemp(join(tmpdir(), "boxes-guest-pack-"))),
          (directory) => Effect.promise(() => rm(directory, { recursive: true, force: true })),
        );
        const notices = join(directory, "notices");
        const nested = `${"a".repeat(64)}/${"b".repeat(64)}`;
        yield* Effect.promise(() => mkdir(join(notices, nested), { recursive: true }));
        const image = Buffer.from("\0asm\x01\0\0\0");
        yield* Effect.promise(() => Bun.write(join(directory, "sh.wasm"), image));
        const command = [
          join(import.meta.dir, "../target/release/boxes-guest-pack"),
          join(directory, "sh.wasm"),
          notices,
        ];
        const missing = Bun.spawnSync([...command, join(directory, "missing.aospkg")]);
        expect(missing.exitCode).not.toBe(0);
        expect(missing.stderr.toString()).toContain("NOTICE");
        yield* Effect.promise(() => Bun.write(join(notices, "NOTICE"), "Boxes test notice\n"));
        const license = "A long-path notice with preserved contents.\n";
        yield* Effect.promise(() => Bun.write(join(notices, nested, "LICENSE"), license));
        const outputs = yield* Effect.forEach(["first", "second"], (name) =>
          Effect.gen(function* () {
            const output = join(directory, `${name}.aospkg`);
            const result = Bun.spawnSync([...command, output]);
            expect(result.exitCode).toBe(0);
            return yield* Effect.promise(() => Bun.file(output).bytes());
          }),
        );
        expect(outputs[0]).toEqual(outputs[1]);
        const bytes = outputs[0];
        const plan = Schema.decodeUnknownSync(Schema.fromJsonString(PackagePreparation))(
          prepare_package(bytes),
        );
        expect(plan.installed.manifest.commands).toEqual([{ command: "sh", entry: "bin/sh" }]);
        const sourceFiles = [
          { path: "bin/sh", bytes: image },
          { path: "share/boxes-sh/NOTICE", bytes: Buffer.from("Boxes test notice\n") },
          { path: `share/boxes-sh/${nested}/LICENSE`, bytes: Buffer.from(license) },
        ];
        for (const source of sourceFiles) {
          const entry = plan.entries.find((entry) => entry.path === `${plan.root}/${source.path}`);
          expect(entry?.node.kind).toBe("file");
          if (entry?.node.kind !== "file") return yield* Effect.die("Missing packaged file");
          expect(entry.node.mode & 0o222).toBe(0);
          expect(entry.mtimeNs).toBe("0");
          const content = Buffer.concat(
            entry.node.chunks.map((hash) => {
              const block = plan.blocks.find((block) => block.hash === hash);
              expect(block).toBeDefined();
              if (block === undefined) return Buffer.alloc(0);
              return Buffer.from(bytes.subarray(block.offset, block.offset + block.length));
            }),
          );
          expect(content).toEqual(source.bytes);
        }
        yield* Effect.promise(() => symlink("NOTICE", join(notices, "linked")));
        const unsafe = Bun.spawnSync([...command, join(directory, "unsafe.aospkg")]);
        expect(unsafe.exitCode).not.toBe(0);
        expect(unsafe.stderr.toString()).toContain("regular files");
        expect(
          yield* Effect.promise(() => Bun.file(join(directory, "unsafe.aospkg")).exists()),
        ).toBe(false);
      }),
    ),
  ));
