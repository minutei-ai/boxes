import { Effect, Match, Schema } from "effect";
import { join } from "node:path";
import { homedir } from "node:os";

class BuildFailure extends Schema.TaggedError<BuildFailure>()("BuildFailure", {
  message: Schema.String,
  cause: Schema.Unknown,
}) {}
const root = join(import.meta.dir, "..");
const run = Effect.fn("build.command")(function* (args: string[]) {
  if (args[0] === "rustc") {
    const source = args.find((argument) => argument.endsWith(".rs"));
    const outputIndex = args.indexOf("-o");
    const targetIndex = args.indexOf("--target");
    if (source === undefined || outputIndex < 0 || targetIndex < 0)
      return yield* new BuildFailure({
        message: "Rust fixture requires source, target and output",
        cause: args,
      });
    const recipe = new Bun.CryptoHasher("sha256")
      .update(JSON.stringify(args))
      .digest("hex")
      .slice(0, 16);
    const name = `boxes-fixture-${recipe}`;
    const directory = join(root, "target/fixtures", recipe);
    const library = args.includes("cdylib");
    const manifest = [
      "[package]",
      `name = "${name}"`,
      'version = "0.0.0"',
      'edition = "2015"',
      'build = "build.rs"',
      "[workspace]",
      "[profile.release]",
      'strip = "symbols"',
      'panic = "abort"',
    ];
    if (library)
      manifest.push(
        "[lib]",
        `path = ${JSON.stringify(join(root, source))}`,
        'crate-type = ["cdylib"]',
      );
    else
      manifest.push("[[bin]]", `name = "${name}"`, `path = ${JSON.stringify(join(root, source))}`);
    const configuration = args.flatMap((argument, index) => {
      if (argument === "--cfg")
        return [`println!(${JSON.stringify(`cargo:rustc-cfg=${args[index + 1]}`)});`];
      if (argument === "-C" && args[index + 1]?.startsWith("link-arg="))
        return [`println!(${JSON.stringify(`cargo:rustc-link-arg=${args[index + 1].slice(9)}`)});`];
      return [];
    });
    const generated = [
      [join(directory, "Cargo.toml"), manifest.join("\n") + "\n"],
      [
        join(directory, "build.rs"),
        `fn main() { println!("cargo:rustc-check-cfg=cfg(case, values(any()))"); ${configuration.join(" ")} }\n`,
      ],
    ];
    yield* Effect.forEach(generated, ([path, source]) =>
      Effect.promise(async () => {
        const file = Bun.file(path);
        if ((await file.exists()) && (await file.text()) === source) return;
        await Bun.write(path, source);
      }),
    );
    const target = args[targetIndex + 1];
    const child = Bun.spawn(
      [
        "cargo",
        "build",
        "--manifest-path",
        join(directory, "Cargo.toml"),
        "--target-dir",
        join(root, "target/fixtures-build"),
        "--target",
        target,
        "--release",
      ],
      { cwd: root, stdout: "inherit", stderr: "inherit" },
    );
    const code = yield* Effect.promise(() => child.exited);
    if (code !== 0)
      return yield* new BuildFailure({ message: "Rust fixture build failed", cause: code });
    const artifact = name.replaceAll("-", "_");
    const built = Match.value(library).pipe(
      Match.when(true, () => artifact),
      Match.orElse(() => name),
    );
    yield* Effect.promise(() =>
      Bun.write(
        join(root, args[outputIndex + 1]),
        Bun.file(join(root, "target/fixtures-build", target, "release", `${built}.wasm`)),
      ),
    );
    return;
  }
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
    const wasiBinary = yield* Effect.promise(() =>
      Bun.file(join(root, "dist/wasi/cirro_wasi_bg.wasm")).arrayBuffer(),
    );
    const wasiDigest = yield* Effect.promise(() => crypto.subtle.digest("SHA-256", wasiBinary));
    yield* Effect.promise(() =>
      Bun.write(
        join(root, "dist/wasi/revision.json"),
        JSON.stringify({ sha256: Buffer.from(wasiDigest).toString("hex") }) + "\n",
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
    for (const fixture of ["normal", "blocked", "parent", "child", "session", "sink"]) {
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
        "tests/fixtures/wasi-pty.rs",
        "-o",
        `dist/wasi-pty-${fixture}.wasm`,
      ]);
    }
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
      "path-absolute",
      "path-empty",
      "path-chdir",
      "path-slash",
      "sched-zero",
      "path-missing",
      "path-absent",
      "path-denied",
      "sched-priority",
      "sched-policy",
      "missing",
      "file",
      "closed",
      "malformed",
      "redirect",
      "open-dir",
      "exclusive",
      "open-close",
      "closefrom",
      "closefrom-root",
      "closefrom-high",
      "closefrom-negative",
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
    for (const mode of [
      "image",
      "path",
      "fexec",
      "fexec-unlink",
      "fexec-rename",
      "fexec-cloexec",
      "fexec-closed",
      "signal",
      "pending",
      "missing",
      "invalid",
      "denied",
      "badfd",
      "start",
      "start-trap",
      "loop",
      "child",
      "children",
      "leaf",
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
        "tests/fixtures/wasi-exec.rs",
        "-o",
        `dist/wasi-exec-${mode}.wasm`,
      ]);
    }
    for (const [mode, entry] of [
      ["start", "bootstrap"],
      ["start-trap", "bootstrap_trap"],
    ] as const) {
      yield* run([
        "cargo",
        "run",
        "-p",
        "cirro-wasm-meter",
        "--release",
        "--locked",
        "--",
        "dist/wasi-exec-image.wasm",
        `dist/wasi-exec-image-${mode}.wasm`,
        "--start",
        entry,
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
    for (const mode of [
      "self",
      "external",
      "restart",
      "external-io",
      "inherit",
      "inherit-default",
      "chld",
      "chld-stop",
      "nocldstop",
      "autoreap-ignore",
      "autoreap-default",
      "autoreap-user",
      "autoreap-late",
      "autoreap-many",
      "autoreap-multi",
      "cont-handler",
      "ignore-cont",
      "restart-poll",
      "child-ignorecont",
      "child-poll",
      "child-handler",
      "child-restart",
      "child-io",
      "child-inherit",
      "child-exit",
      "coalesce",
      "sliced",
      "infinite",
      "missing",
      "bad-signature",
      "nest-limit",
      "defer",
      "nodefer",
      "sa-mask",
      "reset",
      "upper",
      "io",
    ] as const) {
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
        "tests/fixtures/wasi-handlers.rs",
        "-o",
        `dist/wasi-handlers-${mode}.wasm`,
      ]);
    }
    for (const mode of [
      "child",
      "child-masked",
      "child-unmask",
      "child-natural",
      "child-wait",
      "child-inherited",
      "child-stopself",
      "child-maskstop",
      "child-clock",
      "pid",
      "group",
      "masked",
      "unmask",
      "natural",
      "wait",
      "upper",
      "self",
      "self-pause",
      "inherit-mask",
      "stop",
      "tstp",
      "stop-kill",
      "stop-term",
      "self-stop",
      "stop-masked",
      "stop-group",
      "stop-zero",
      "stop-clock",
    ] as const) {
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
        "tests/fixtures/wasi-signals.rs",
        "-o",
        `dist/wasi-signals-${mode}.wasm`,
      ]);
    }
    for (const mode of ["new", "join", "inherit", "session"] as const) {
      for (const role of ["parent", "child"] as const) {
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
          `case="${role}-${mode}"`,
          "tests/fixtures/wasi-groups.rs",
          "-o",
          `dist/wasi-groups-${role}-${mode}.wasm`,
        ]);
      }
    }
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
      'case="grandchild-session"',
      "tests/fixtures/wasi-groups.rs",
      "-o",
      "dist/wasi-groups-grandchild-session.wasm",
    ]);
    for (const role of [
      "parent",
      "child",
      "child-rename",
      "child-trap",
      "child-oob",
      "parent-trap",
      "parent-closefrom",
      "denied",
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
      "--edition",
      "2024",
      "--target",
      "wasm32-unknown-unknown",
      "--crate-type",
      "cdylib",
      "-C",
      "opt-level=2",
      "-C",
      "panic=abort",
      "tests/fixtures/wasi-closefrom.rs",
      "-o",
      "dist/wasi-closefrom.wasm",
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
      "tests/fixtures/wasi-stdin.rs",
      "-o",
      "dist/wasi-stdin.wasm",
    ]);
    yield* run([
      "rustc",
      "--target",
      "wasm32-wasip1",
      "-O",
      "-C",
      "strip=symbols",
      "--cfg",
      'case="close"',
      "tests/fixtures/wasi-stdin.rs",
      "-o",
      "dist/wasi-stdin-close.wasm",
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
      "--cfg",
      "ready",
      "tests/fixtures/wasi-background.rs",
      "-o",
      "dist/wasi-background-ready.wasm",
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
    yield* run([
      "rustc",
      "--target",
      "wasm32-wasip1",
      "-O",
      "-C",
      "strip=symbols",
      "tests/fixtures/wasi-umask.rs",
      "-o",
      "dist/wasi-umask.wasm",
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
    yield* run([
      "rustc",
      "--crate-type",
      "cdylib",
      "--target",
      "wasm32-unknown-unknown",
      "-O",
      "-C",
      "strip=symbols",
      "tests/fixtures/wasi-recovery.rs",
      "-o",
      "dist/wasi-recovery.wasm",
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
      'case="unsynced"',
      "tests/fixtures/wasi-recovery.rs",
      "-o",
      "dist/wasi-recovery-unsynced.wasm",
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
      "tests/fixtures/wasi-recovery-family.rs",
      "-o",
      "dist/wasi-recovery-family.wasm",
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
      'case="stopped"',
      "tests/fixtures/wasi-recovery-family.rs",
      "-o",
      "dist/wasi-recovery-stopped.wasm",
    ]);
    yield* run([
      "rustc",
      "--target",
      "wasm32-wasip1",
      "-O",
      "-C",
      "strip=symbols",
      "--cfg",
      'case="resume-parent"',
      "tests/fixtures/wasi-stdin.rs",
      "-o",
      "dist/wasi-stdin-resume-parent.wasm",
    ]);
    yield* run([
      "rustc",
      "--target",
      "wasm32-wasip1",
      "-O",
      "-C",
      "strip=symbols",
      "tests/fixtures/wasi-raw-stdio.rs",
      "-o",
      "dist/wasi-raw-stdio.wasm",
    ]);
    yield* run([
      "rustc",
      "--target",
      "wasm32-wasip1",
      "-O",
      "-C",
      "strip=symbols",
      "tests/fixtures/wasi-advice.rs",
      "-o",
      "dist/wasi-advice.wasm",
    ]);
    yield* run([
      "rustc",
      "--target",
      "wasm32-wasip1",
      "-O",
      "-C",
      "strip=symbols",
      "tests/fixtures/wasi-attenuation.rs",
      "-o",
      "dist/wasi-attenuation.wasm",
    ]);
    yield* run([
      "rustc",
      "--target",
      "wasm32-wasip1",
      "-O",
      "-C",
      "strip=symbols",
      "--cfg",
      'case="checkpoint"',
      "tests/fixtures/wasi-attenuation.rs",
      "-o",
      "dist/wasi-attenuation-checkpoint.wasm",
    ]);
    yield* run([
      "rustc",
      "--target",
      "wasm32-wasip1",
      "-O",
      "-C",
      "strip=symbols",
      "tests/fixtures/wasi-hardlinks.rs",
      "-o",
      "dist/wasi-hardlinks.wasm",
    ]);
    for (const [entry, directory] of [
      ["src/index.ts", "dist/worker"],
      ["tests/fixtures/checkpoint-worker.ts", "dist/checkpoint-worker"],
      ["tests/fixtures/clock-worker.ts", "dist/clock-worker"],
      ["tests/fixtures/origin-worker.ts", "dist/origin-worker"],
      ["tests/fixtures/sdk-binding-worker.ts", "dist/sdk-binding-worker"],
      ["tests/fixtures/remote-binding-worker.ts", "dist/remote-binding-worker"],
    ] as const) {
      const result = yield* Effect.promise(() =>
        Bun.build({
          entrypoints: [join(root, entry)],
          outdir: join(root, directory),
          naming: "index.js",
          target: "browser",
          format: "esm",
          minify: true,
          external: ["cloudflare:workers"],
          plugins: [
            {
              name: "wasm-module",
              setup(builder) {
                builder.onResolve(
                  { filter: /^cirro:(wasm|guest|compiler|wasi|python)$/ },
                  (args) => {
                    const name = args.path.slice(6);
                    if (name === "wasm") return { path: "./cirro_kernel_bg.wasm", external: true };
                    return { path: `./cirro_${name}_bg.wasm`, external: true };
                  },
                );
                builder.onResolve({ filter: /^env$/ }, () => ({
                  path: join(root, "src/clock.ts"),
                }));
              },
            },
          ],
        }),
      );
      if (!result.success)
        return yield* new BuildFailure({ message: "Worker bundle failed", cause: result.logs });
      if (directory === "dist/sdk-binding-worker" || directory === "dist/remote-binding-worker")
        continue;
      yield* Effect.forEach(["kernel", "guest", "compiler", "wasi", "python"], (name) =>
        Effect.promise(() =>
          Bun.write(
            join(root, `${directory}/cirro_${name}_bg.wasm`),
            Bun.file(join(root, `dist/${name}/cirro_${name}_bg.wasm`)),
          ),
        ),
      );
    }
  }),
);
