import { Effect, Schema } from "effect";
import { chmod, mkdir, mkdtemp, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { Digest } from "../src/contracts";
import { readBounded } from "../src/http";

const binaryDigest = "8f25e9fd5db0fc5f210003aaa432922feb2e52d309e430def2f929e34da9466b";
const archiveDigest = "2dc9c7813f5375db93d96ead4b78222fcc3e2677bbb832297af4797782a37489";
const flags = [
  "-O1",
  "--asyncify",
  "--pass-arg=asyncify-imports@boxes_python.request",
  "--enable-mutable-globals",
  "--enable-sign-ext",
  "--enable-nontrapping-float-to-int",
  "--enable-bulk-memory",
  "--enable-bulk-memory-opt",
  "--enable-reference-types",
  "--enable-multivalue",
];
const Artifact = Schema.Struct({ sha256: Digest });

export const asyncifyPython = Effect.fn("build.python.asyncify")(function* (root: string) {
  if (process.platform !== "linux" || process.arch !== "x64")
    return yield* Effect.die("The pinned Python Asyncify build requires Linux x64");
  const input = join(root, "dist/python/cirro_python_bg.wasm");
  const bytes = yield* Effect.promise(() => Bun.file(input).arrayBuffer());
  const key = new Bun.CryptoHasher("sha256")
    .update(binaryDigest)
    .update(JSON.stringify(flags))
    .update(bytes)
    .digest("hex");
  const directory = join(root, "target/python-asyncify");
  const cached = join(directory, `${key}.wasm`);
  const manifest = join(directory, `${key}.json`);
  const metadata = Bun.file(manifest);
  if (yield* Effect.promise(() => metadata.exists())) {
    const record = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Artifact))(
      yield* Effect.promise(() => metadata.text()),
    );
    const output = yield* Effect.promise(() => Bun.file(cached).arrayBuffer());
    if (new Bun.CryptoHasher("sha256").update(output).digest("hex") !== record.sha256)
      return yield* Effect.die("Cached Python Asyncify artifact digest mismatch");
    yield* Effect.promise(() => Bun.write(input, output));
    return;
  }
  yield* Effect.promise(() => mkdir(directory, { recursive: true }));
  yield* Effect.scoped(
    Effect.gen(function* () {
      const temporary = yield* Effect.acquireRelease(
        Effect.promise(() => mkdtemp(join(directory, "compile-"))),
        (path) => Effect.promise(() => rm(path, { recursive: true, force: true })),
      );
      const binary = join(directory, "wasm-opt-version_133-linux-x64");
      if (!(yield* Effect.promise(() => Bun.file(binary).exists()))) {
        const response = yield* Effect.tryPromise(() =>
          fetch(
            "https://github.com/WebAssembly/binaryen/releases/download/version_133/binaryen-version_133-x86_64-linux.tar.gz",
            { signal: AbortSignal.timeout(120000) },
          ),
        );
        if (response.status !== 200) return yield* Effect.die({ status: response.status });
        const archive = yield* readBounded(response.body, 111_200_018);
        if (
          archive.byteLength !== 111_200_018 ||
          new Bun.CryptoHasher("sha256").update(archive).digest("hex") !== archiveDigest
        )
          return yield* Effect.die("Binaryen archive digest mismatch");
        const path = join(temporary, "binaryen.tar.gz");
        yield* Effect.promise(() => Bun.write(path, archive));
        const extraction = Bun.spawn(
          ["tar", "-xzf", path, "-C", temporary, "binaryen-version_133/bin/wasm-opt"],
          { stdout: "inherit", stderr: "inherit" },
        );
        if ((yield* Effect.promise(() => extraction.exited)) !== 0)
          return yield* Effect.die("Binaryen extraction failed");
        yield* Effect.promise(() =>
          rename(join(temporary, "binaryen-version_133/bin/wasm-opt"), binary),
        );
      }
      const compiler = yield* Effect.promise(() => Bun.file(binary).arrayBuffer());
      if (new Bun.CryptoHasher("sha256").update(compiler).digest("hex") !== binaryDigest)
        return yield* Effect.die("Binaryen compiler digest mismatch");
      yield* Effect.promise(() => chmod(binary, 0o755));
      const output = join(temporary, "python.wasm");
      const compilation = Bun.spawn([binary, input, ...flags, "-o", output], {
        stdout: "inherit",
        stderr: "inherit",
        env: { ...Bun.env, BINARYEN_CORES: "4" },
      });
      if ((yield* Effect.promise(() => compilation.exited)) !== 0)
        return yield* Effect.die("Python Asyncify compilation failed");
      const compiled = yield* Effect.promise(() => Bun.file(output).arrayBuffer());
      const sha256 = new Bun.CryptoHasher("sha256").update(compiled).digest("hex");
      const description = join(temporary, "artifact.json");
      yield* Effect.promise(() =>
        Bun.write(description, Schema.encodeSync(Schema.fromJsonString(Artifact))({ sha256 })),
      );
      yield* Effect.promise(() => rename(output, cached));
      yield* Effect.promise(() => rename(description, manifest));
      yield* Effect.promise(() => Bun.write(input, compiled));
    }),
  );
});
