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
    const targets = { kernel: "web", guest: "web", compiler: "no-modules" } as const;
    yield* Effect.forEach(["kernel", "guest", "compiler"] as const, (name) =>
      run([
        join(homedir(), ".cargo/bin/wasm-bindgen"),
        `target/wasm32-unknown-unknown/release/cirro_${name}.wasm`,
        "--target",
        targets[name],
        "--out-dir",
        `dist/${name}`,
      ]),
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
              builder.onResolve({ filter: /^cirro:(wasm|guest|compiler)$/ }, (args) => {
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
    yield* Effect.forEach(["kernel", "guest", "compiler"], (name) =>
      Effect.promise(() =>
        Bun.write(
          join(root, `dist/worker/cirro_${name}_bg.wasm`),
          Bun.file(join(root, `dist/${name}/cirro_${name}_bg.wasm`)),
        ),
      ),
    );
  }),
);
