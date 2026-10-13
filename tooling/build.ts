import { Effect, Schema } from "effect";
import { join } from "node:path";
import { homedir } from "node:os";

class BuildFailure extends Schema.TaggedError<BuildFailure>()("BuildFailure", {
  message: Schema.String,
  cause: Schema.Unknown,
}) {}
const root = join(import.meta.dir, "..");
const run = Effect.fn("build.command")(function* (args: string[]) {
  const child = Bun.spawn(args, { cwd: root, stdout: "inherit", stderr: "inherit" });
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
      "--target",
      "wasm32-unknown-unknown",
      "--release",
      "--locked",
    ]);
    yield* run([
      join(homedir(), ".cargo/bin/wasm-bindgen"),
      "target/wasm32-unknown-unknown/release/cirro_kernel.wasm",
      "--target",
      "web",
      "--out-dir",
      "dist/wasm",
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
    const guest = yield* Effect.promise(() =>
      Bun.build({
        entrypoints: [join(root, "src/guest.ts")],
        target: "browser",
        format: "esm",
        minify: true,
        plugins: [
          {
            name: "program",
            setup(builder) {
              builder.onResolve({ filter: /program\.js$/ }, () => ({
                path: "./program.js",
                external: true,
              }));
            },
          },
        ],
      }),
    );
    if (!guest.success)
      return yield* new BuildFailure({ message: "Guest bundle failed", cause: guest.logs });
    const source = yield* Effect.promise(() => guest.outputs[0].text());
    yield* Effect.promise(() =>
      Bun.write(join(root, "dist/guest-source.json"), JSON.stringify(source)),
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
              builder.onResolve({ filter: /^cirro:wasm$/ }, () => ({
                path: "./cirro_kernel_bg.wasm",
                external: true,
              }));
            },
          },
        ],
      }),
    );
    if (!result.success)
      return yield* new BuildFailure({ message: "Worker bundle failed", cause: result.logs });
    yield* Effect.promise(() =>
      Bun.write(
        join(root, "dist/worker/cirro_kernel_bg.wasm"),
        Bun.file(join(root, "dist/wasm/cirro_kernel_bg.wasm")),
      ),
    );
  }),
);
