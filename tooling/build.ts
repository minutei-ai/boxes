import { Effect, Schema } from "effect";
import { join } from "node:path";
import { homedir } from "node:os";

class BuildFailure extends Schema.TaggedError<BuildFailure>()("BuildFailure", {
  message: Schema.String,
  cause: Schema.Unknown,
}) {}
const root = join(import.meta.dir, "..");
const run = Effect.fn("build.command")(function* (args: string[]) {
  const child = Bun.spawn(args, {
    cwd: root,
    stdout: "inherit",
    stderr: "inherit",
    env: { ...Bun.env, CC_wasm32_unknown_unknown: "clang", AR_wasm32_unknown_unknown: "llvm-ar" },
  });
  const code = yield* Effect.promise(() => child.exited);
  if (code !== 0)
    return yield* new BuildFailure({ message: `${args[0]} exited ${code}`, cause: code });
});
await Effect.runPromise(
  Effect.gen(function* () {
    yield* run([
      "cargo",
      "build",
      "-p",
      "cirro-kernel",
      "-p",
      "cirro-guest",
      "-p",
      "cirro-wasi",
      "-p",
      "cirro-python",
      "--target",
      "wasm32-unknown-unknown",
      "--release",
      "--locked",
    ]);
    yield* run([
      "cargo",
      "rustc",
      "-p",
      "cirro-compiler",
      "--target",
      "wasm32-unknown-unknown",
      "--release",
      "--locked",
      "--",
      "-C",
      "link-arg=--max-memory=67108864",
    ]);
    const targets = {
      kernel: ["--target", "web"],
      guest: ["--target", "web"],
      compiler: ["--target", "no-modules"],
      wasi: ["--target", "no-modules", "--no-modules-global", "cirroWasi"],
      python: [
        "--target",
        "no-modules",
        "--no-modules-global",
        "cirroPython",
        "--remove-name-section",
        "--remove-producers-section",
      ],
    } as const;
    yield* Effect.forEach(["kernel", "guest", "compiler", "wasi", "python"] as const, (name) =>
      run([
        join(homedir(), ".cargo/bin/wasm-bindgen"),
        `target/wasm32-unknown-unknown/release/cirro_${name}.wasm`,
        ...targets[name],
        "--out-dir",
        `dist/${name}`,
      ]),
    );
    yield* run([
      "cargo",
      "run",
      "-p",
      "cirro-wasm-meter",
      "--release",
      "--locked",
      "--",
      "dist/python/cirro_python_bg.wasm",
      "dist/python/metered.wasm",
    ]);
    yield* Effect.promise(() =>
      Bun.write(
        join(root, "dist/python/cirro_python_bg.wasm"),
        Bun.file(join(root, "dist/python/metered.wasm")),
      ),
    );
    const pythonGenerated = yield* Effect.promise(() =>
      Bun.file(join(root, "dist/python/cirro_python.js")).text(),
    );
    const destructor = "            wasm.__wbg_pythonguest_free(ptr, 0);";
    if (!pythonGenerated.includes(destructor))
      return yield* new BuildFailure({
        message: "Python binding destructor changed",
        cause: pythonGenerated.slice(0, 100),
      });
    const python = pythonGenerated.replace(destructor, "            void ptr;");
    const pythonTypes = yield* Effect.promise(() =>
      Bun.file(join(root, "dist/python/cirro_python.d.ts")).text(),
    );
    yield* Effect.promise(() =>
      Bun.write(
        join(root, "dist/python/cirro_python.d.ts"),
        "export {};\n" +
          pythonTypes
            .replace(
              "declare interface InitOutput {",
              "declare interface InitOutput {\n    readonly __cirro_limits: (fuel: bigint, pages: number) => void;\n    readonly __cirro_fuel: WebAssembly.Global;",
            )
            .replaceAll("declare namespace cirroPython", "export declare namespace cirroPython")
            .replaceAll("declare function cirroPython", "export declare function cirroPython"),
      ),
    );
    yield* Effect.promise(() =>
      Bun.write(
        join(root, "dist/python/bindings.js"),
        `export const createBindings = () => {\n${python}\nreturn cirroPython;\n};\n`,
      ),
    );
    yield* Effect.promise(() =>
      Bun.write(
        join(root, "dist/python/bindings.d.ts"),
        'import { cirroPython } from "./cirro_python";\nexport declare const createBindings: () => typeof cirroPython;\n',
      ),
    );
    const compiler = yield* Effect.promise(() =>
      Bun.file(join(root, "dist/compiler/cirro_compiler.js")).text(),
    );
    yield* Effect.promise(() =>
      Bun.write(
        join(root, "dist/compiler/bindings.js"),
        `export const createBindings = () => {\n${compiler}\nreturn wasm_bindgen;\n};\n`,
      ),
    );
    yield* Effect.promise(() =>
      Bun.write(
        join(root, "dist/compiler/bindings.d.ts"),
        'import "./cirro_compiler";\nexport declare const createBindings: () => typeof wasm_bindgen;\n',
      ),
    );
    const wasi = yield* Effect.promise(() =>
      Bun.file(join(root, "dist/wasi/cirro_wasi.js")).text(),
    );
    const wasiTypes = yield* Effect.promise(() =>
      Bun.file(join(root, "dist/wasi/cirro_wasi.d.ts")).text(),
    );
    yield* Effect.promise(() =>
      Bun.write(
        join(root, "dist/wasi/cirro_wasi.d.ts"),
        "export {};\n" +
          wasiTypes
            .replaceAll("declare namespace cirroWasi", "export declare namespace cirroWasi")
            .replaceAll("declare function cirroWasi", "export declare function cirroWasi"),
      ),
    );
    yield* Effect.promise(() =>
      Bun.write(
        join(root, "dist/wasi/bindings.js"),
        `export const createBindings = () => {\n${wasi}\nreturn cirroWasi;\n};\n`,
      ),
    );
    yield* Effect.promise(() =>
      Bun.write(
        join(root, "dist/wasi/bindings.d.ts"),
        'import { cirroWasi } from "./cirro_wasi";\nexport declare const createBindings: () => typeof cirroWasi;\n',
      ),
    );
    for (const fixture of ["normal", "blocked"]) {
      yield* run([
        "rustc",
        "--crate-type",
        "cdylib",
        "--target",
        "wasm32-unknown-unknown",
        "-O",
        "-C",
        "strip=symbols",
        "--cfg",
        `case="${fixture}"`,
        "tests/fixtures/wasi-pipe.rs",
        "-o",
        `dist/wasi-pipe-${fixture}.wasm`,
      ]);
    }
    yield* run([
      "rustc",
      "--crate-type",
      "cdylib",
      "--target",
      "wasm32-unknown-unknown",
      "-O",
      "-C",
      "strip=symbols",
      "tests/fixtures/wasi-signal-mask.rs",
      "-o",
      "dist/wasi-signal-mask.wasm",
    ]);
    for (const mode of [
      "explicit",
      "relative",
      "chdir",
      "fchdir",
      "symlink",
      "missing",
      "file",
      "closed",
      "malformed",
      "redirect",
      "open-dir",
      "exclusive",
      "open-close",
      "readonly",
      "nofollow",
    ]) {
      yield* run([
        "rustc",
        "--crate-type",
        "cdylib",
        "--target",
        "wasm32-unknown-unknown",
        "-O",
        "-A",
        "dead_code",
        "-C",
        "strip=symbols",
        "--cfg",
        `case="${mode}"`,
        "tests/fixtures/wasi-cwd.rs",
        "-o",
        `dist/wasi-cwd-${mode}.wasm`,
      ]);
    }
    for (const role of [
      "parent-duplex",
      "child-duplex",
      "parent-drain",
      "child-drain",
      "parent-blocked",
    ]) {
      yield* run([
        "rustc",
        "--crate-type",
        "cdylib",
        "--target",
        "wasm32-unknown-unknown",
        "-O",
        "-A",
        "dead_code",
        "-C",
        "strip=symbols",
        "--cfg",
        `case="${role}"`,
        "tests/fixtures/wasi-inherited-pipe.rs",
        "-o",
        `dist/wasi-inherited-pipe-${role}.wasm`,
      ]);
    }
    for (const role of ["parent", "child", "child-rename", "denied"]) {
      yield* run([
        "rustc",
        "--crate-type",
        "cdylib",
        "--target",
        "wasm32-unknown-unknown",
        "-O",
        "-A",
        "dead_code",
        "-C",
        "strip=symbols",
        "--cfg",
        `case="${role}"`,
        "tests/fixtures/wasi-child.rs",
        "-o",
        `dist/wasi-child-${role}.wasm`,
      ]);
    }
    for (const mode of ["finite", "infinite"]) {
      yield* run([
        "rustc",
        "--crate-type",
        "cdylib",
        "--target",
        "wasm32-unknown-unknown",
        "-O",
        "-C",
        "strip=symbols",
        "--cfg",
        `case="${mode}"`,
        "tests/fixtures/wasi-slices.rs",
        "-o",
        `dist/wasi-slices-${mode}.wasm`,
      ]);
    }
    for (const role of ["parent", "child"]) {
      yield* run([
        "rustc",
        "--crate-type",
        "cdylib",
        "--target",
        "wasm32-unknown-unknown",
        "-O",
        "-C",
        "strip=symbols",
        "--cfg",
        `case="${role}"`,
        "tests/fixtures/wasi-shared-file.rs",
        "-o",
        `dist/wasi-shared-file-${role}.wasm`,
      ]);
    }
    yield* run([
      "rustc",
      "--crate-type",
      "cdylib",
      "--target",
      "wasm32-unknown-unknown",
      "-O",
      "-C",
      "strip=symbols",
      "tests/fixtures/wasi-fd-dup.rs",
      "-o",
      "dist/wasi-fd-dup.wasm",
    ]);
    yield* run([
      "rustc",
      "--crate-type",
      "cdylib",
      "--target",
      "wasm32-unknown-unknown",
      "-O",
      "-C",
      "strip=symbols",
      "tests/fixtures/wasi-host-stat.rs",
      "-o",
      "dist/wasi-host-stat.wasm",
    ]);
    yield* run([
      "rustc",
      "--crate-type",
      "cdylib",
      "--target",
      "wasm32-unknown-unknown",
      "-O",
      "-C",
      "strip=symbols",
      "--cfg",
      'case="denied"',
      "tests/fixtures/wasi-host-stat.rs",
      "-o",
      "dist/wasi-host-stat-denied.wasm",
    ]);
    yield* run([
      "rustc",
      "--crate-type",
      "cdylib",
      "--target",
      "wasm32-unknown-unknown",
      "-O",
      "-C",
      "strip=symbols",
      "tests/fixtures/wasi-large.rs",
      "-o",
      "dist/wasi-large.wasm",
    ]);
    yield* run([
      "rustc",
      "--crate-type",
      "cdylib",
      "--target",
      "wasm32-unknown-unknown",
      "-O",
      "-C",
      "strip=symbols",
      "-C",
      "panic=abort",
      "tests/fixtures/guest.rs",
      "-o",
      "dist/guest-test.wasm",
    ]);
    yield* run([
      "rustc",
      "--target",
      "wasm32-wasip1",
      "-O",
      "-C",
      "strip=symbols",
      "tests/fixtures/wasi.rs",
      "-o",
      "dist/wasi-test.wasm",
    ]);
    yield* run([
      "rustc",
      "--target",
      "wasm32-wasip1",
      "-O",
      "-C",
      "strip=symbols",
      "tests/fixtures/wasi-inputs.rs",
      "-o",
      "dist/wasi-inputs.wasm",
    ]);
    yield* run([
      "rustc",
      "--target",
      "wasm32-wasip1",
      "-O",
      "-C",
      "strip=symbols",
      "tests/fixtures/wasi-paths.rs",
      "-o",
      "dist/wasi-paths.wasm",
    ]);
    yield* run([
      "rustc",
      "--target",
      "wasm32-wasip1",
      "-O",
      "-C",
      "strip=symbols",
      "tests/fixtures/wasi-setters.rs",
      "-o",
      "dist/wasi-setters.wasm",
    ]);
    yield* run([
      "rustc",
      "--target",
      "wasm32-wasip1",
      "-O",
      "-C",
      "strip=symbols",
      "tests/fixtures/wasi-background.rs",
      "-o",
      "dist/wasi-background.wasm",
    ]);
    yield* run([
      "rustc",
      "--target",
      "wasm32-wasip1",
      "-O",
      "-C",
      "strip=symbols",
      "tests/fixtures/wasi-live-output.rs",
      "-o",
      "dist/wasi-live-output.wasm",
    ]);
    yield* run([
      "rustc",
      "--target",
      "wasm32-wasip1",
      "-O",
      "-C",
      "strip=symbols",
      "tests/fixtures/wasi-poll.rs",
      "-o",
      "dist/wasi-poll.wasm",
    ]);
    yield* run([
      "rustc",
      "--target",
      "wasm32-wasip1",
      "-O",
      "-C",
      "strip=symbols",
      "tests/fixtures/wasi-host-fs.rs",
      "-o",
      "dist/wasi-host-fs.wasm",
    ]);
    yield* Effect.forEach(
      [
        "allocate-rights",
        "allocate-denied",
        "allocate-overflow",
        "poll-abi",
        "poll-rights",
        "poll-earliest",
        "poll-expiry",
        "package-times",
        "setter-escape",
        "setter-rights",
        "setter-flags",
        "setter-denied",
        "setter-trap",
        "setter-synced-trap",
        "setter-now",
        "bad-pointer",
        "directory-cookies",
        "directory-rights",
        "path-types",
        "readlink-small",
        "buffers",
        "race-a",
        "race-b",
        "rights",
        "positioned",
        "aliases",
        "budget",
        "writeonly",
        "writeonly-write",
        "escape",
        "nofollow",
        "symlink-escape",
        "descriptors",
        "closed-stdio",
        "clock-random",
        "fuel",
        "memory",
        "exit",
        "output",
        "trap",
        "synced-trap",
        "create-denied",
      ],
      (name) =>
        run([
          "rustc",
          "--crate-type",
          "cdylib",
          "--target",
          "wasm32-unknown-unknown",
          "-O",
          "-C",
          "strip=symbols",
          "--cfg",
          `case="${name}"`,
          "tests/fixtures/wasi-abi.rs",
          "-o",
          `dist/wasi-${name}.wasm`,
        ]),
    );
    const result = yield* Effect.promise(() =>
      Bun.build({
        entrypoints: [join(root, "src/index.ts")],
        outdir: join(root, "dist/worker"),
        target: "browser",
        format: "esm",
        minify: true,
        external: ["cloudflare:workers"],
        plugins: [
          {
            name: "wasm-module",
            setup(builder) {
              builder.onResolve({ filter: /^cirro:(wasm|guest|compiler|wasi|python)$/ }, (args) => {
                const name = args.path.slice(6);
                if (name === "wasm") return { path: "./cirro_kernel_bg.wasm", external: true };
                return { path: `./cirro_${name}_bg.wasm`, external: true };
              });
              builder.onResolve({ filter: /^env$/ }, () => ({ path: join(root, "src/clock.ts") }));
            },
          },
        ],
      }),
    );
    if (!result.success)
      return yield* new BuildFailure({ message: "Worker bundle failed", cause: result.logs });
    yield* Effect.forEach(["kernel", "guest", "compiler", "wasi", "python"], (name) =>
      Effect.promise(() =>
        Bun.write(
          join(root, `dist/worker/cirro_${name}_bg.wasm`),
          Bun.file(join(root, `dist/${name}/cirro_${name}_bg.wasm`)),
        ),
      ),
    );
  }),
);
