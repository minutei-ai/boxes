import { Clock, Effect, Match, Schema, Struct } from "effect";
import compilerWasm from "cirro:compiler";
import { createBindings } from "../dist/compiler/bindings";
import {
  Capability,
  Fault,
  FileStat,
  ModuleCompilation,
  ModuleBatch,
  ModuleRequest,
  Path,
  ModuleSource,
  RunAction,
  PythonAction,
  ScriptProgram,
  WasmProgram,
  WasmConfiguration,
} from "./contracts";
import { requirePermission } from "./auth";
import { kernelCall, open, read } from "./storage";
import { Kernel } from "../dist/kernel/cirro_kernel";
import type { Env } from "./resources";

const Header = ScriptProgram.mapFields((fields) => Struct.omit(fields, ["modules"]));

export const load = Effect.fn("modules.load")(function* (
  env: Env,
  capability: typeof Capability.Type,
  kernel: Kernel,
  action: typeof RunAction.Type,
) {
  if (
    action.op === "wasm.executeFile" ||
    action.op === "process.execFile" ||
    (action.op === "process.run" && action.language === "wasm")
  ) {
    const defaults = yield* kernelCall(() => kernel.package_environment()).pipe(
      Effect.flatMap(
        Schema.decodeUnknownEffect(Schema.fromJsonString(WasmConfiguration.fields.env)),
      ),
    );
    const binary = yield* Effect.gen(function* () {
      if (action.op === "process.run")
        return { source: action.source, entry: "/tmp/__cirro_inline__.wasm" };
      yield* requirePermission(capability, "read");
      const path = yield* Effect.gen(function* () {
        if (action.op === "wasm.executeFile") return action.path;
        const environment = { ...defaults, ...(action.env ?? {}) };
        return yield* kernelCall(() =>
          kernel.command_path(
            action.command,
            "/home/cirro",
            environment.PATH ?? "/opt/cirro/bin:/usr/local/bin:/usr/bin:/bin",
          ),
        );
      });
      const stat = yield* kernelCall(() => kernel.stat(path, true)).pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(FileStat))),
      );
      if (stat.size > 786_432)
        return yield* new Fault({
          code: "EFBIG",
          status: 413,
          message: "Wasm file exceeds its encoded source limit",
        });
      const data = yield* read(env, capability.sandboxId, kernel, stat.path);
      if (
        action.op === "process.execFile" &&
        !data.subarray(0, 4).equals(Buffer.from([0, 97, 115, 109]))
      )
        return yield* new Fault({
          code: "UNSUPPORTED_RUNTIME",
          status: 501,
          message: "Installed command execution currently requires a WASI module",
        });
      return { source: data.toString("base64"), entry: stat.path };
    });
    const stdin = yield* Effect.gen(function* () {
      if (action.stdin === undefined) return "";
      if (
        action.stdin.encoding === "base64" &&
        !Schema.is(WasmConfiguration.fields.stdin)(action.stdin.content)
      )
        return yield* new Fault({
          code: "EINVAL",
          status: 400,
          message: "Invalid canonical stdin base64",
        });
      const data = Buffer.from(action.stdin.content, action.stdin.encoding);
      if (data.byteLength > 1_048_576)
        return yield* new Fault({ code: "EFBIG", status: 413, message: "Stdin exceeds 1 MiB" });
      const encoded = data.toString("base64");
      if (action.stdin.encoding === "base64" && encoded !== action.stdin.content)
        return yield* new Fault({
          code: "EINVAL",
          status: 400,
          message: "Invalid canonical stdin base64",
        });
      return encoded;
    });
    const program = {
      language: "wasm" as const,
      source: binary.source,
      argv: [binary.entry, ...(action.args ?? [])],
      env: { ...defaults, ...(action.env ?? {}) },
      stdin,
    } satisfies typeof WasmProgram.Type;
    if (
      program.argv.some((value) => !value.isWellFormed() || Buffer.byteLength(value) > 4096) ||
      Object.values(program.env).some(
        (value) => !value.isWellFormed() || Buffer.byteLength(value) > 4096,
      ) ||
      Object.keys(program.env).some((key) => !key.isWellFormed())
    )
      return yield* new Fault({
        code: "EINVAL",
        status: 400,
        message:
          "WASI arguments and environment require valid UTF-8 with at most 4096 bytes per value",
      });
    const configurationBytes = Buffer.byteLength(
      Schema.encodeSync(
        Schema.fromJsonString(
          WasmConfiguration.mapFields((fields) => Struct.omit(fields, ["stdin"])),
        ),
      )(program),
    );
    if (configurationBytes > 65_536)
      return yield* new Fault({
        code: "E2BIG",
        status: 413,
        message: "WASI argv and environment exceed 64 KiB",
      });
    return program;
  }
  if (action.op === "process.run" && action.language === "python")
    return {
      language: "python" as const,
      source: action.source,
      filePath: "/tmp/__cirro_inline__.py",
      mode: "execute" as const,
    };
  if (Schema.is(PythonAction)(action)) {
    if (action.op === "python.execute")
      return {
        language: "python" as const,
        source: action.source,
        filePath: yield* kernelCall(() =>
          kernel.canonical(action.filePath ?? "/tmp/__cirro_inline__.py", "/home/cirro"),
        ),
        mode: "execute" as const,
      };
    if (action.op === "python.evaluate")
      return {
        language: "python" as const,
        source: action.expression,
        filePath: yield* kernelCall(() =>
          kernel.canonical(action.filePath ?? "/tmp/__cirro_inline__.py", "/home/cirro"),
        ),
        mode: "evaluate" as const,
      };
    yield* requirePermission(capability, "read");
    const stat = yield* kernelCall(() => kernel.stat(action.path, true)).pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(FileStat))),
    );
    if (stat.kind !== "file" || stat.size > 1_048_576)
      return yield* new Fault({
        code: "EINVAL",
        status: 400,
        message: "Python entry must be a file up to 1 MiB",
      });
    const data = yield* read(env, capability.sandboxId, kernel, stat.path);
    const source = yield* Effect.try({
      try: () => new TextDecoder("utf-8", { fatal: true }).decode(data),
      catch: () =>
        new Fault({ code: "EILSEQ", status: 422, message: "Python source must be UTF-8" }),
    });
    return { language: "python" as const, source, filePath: stat.path, mode: "execute" as const };
  }
  if (action.op === "process.run" && action.language === "shell")
    return { language: "shell" as const, source: action.source };
  const root = yield* Match.value(action).pipe(
    Match.when({ op: "process.run" }, (action) =>
      Effect.succeed({
        language: action.language,
        mode: "function" as const,
        name: "/tmp/__cirro_inline__.mjs",
        source: action.source,
      }),
    ),
    Match.whenOr({ op: "javascript.execute" }, { op: "typescript.execute" }, (action) =>
      Effect.gen(function* () {
        const name = yield* kernelCall(() =>
          kernel.canonical(action.filePath ?? "/tmp/__cirro_inline__.mjs", "/tmp"),
        );
        if (action.op === "typescript.execute")
          return {
            language: "typescript" as const,
            mode: "module" as const,
            name,
            source: action.source,
          };
        return {
          language: "javascript" as const,
          mode: "module" as const,
          name,
          source: action.source,
        };
      }),
    ),
    Match.whenOr({ op: "javascript.evaluate" }, { op: "typescript.evaluate" }, (action) =>
      Effect.gen(function* () {
        const name = yield* kernelCall(() =>
          kernel.canonical(action.filePath ?? "/tmp/__cirro_inline__.mjs", "/tmp"),
        );
        const source = `export default (${action.expression});`;
        if (action.op === "typescript.evaluate")
          return { language: "typescript" as const, mode: "evaluate" as const, name, source };
        return { language: "javascript" as const, mode: "evaluate" as const, name, source };
      }),
    ),
    Match.whenOr({ op: "javascript.executeFile" }, { op: "typescript.executeFile" }, (action) =>
      Effect.gen(function* () {
        yield* requirePermission(capability, "read");
        const stat = yield* kernelCall(() => kernel.stat(action.path, true)).pipe(
          Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(FileStat))),
        );
        if (stat.kind !== "file")
          return yield* new Fault({
            code: "EISDIR",
            status: 400,
            message: "The script entry must be a file",
          });
        if (stat.size > 1_048_576)
          return yield* new Fault({
            code: "EFBIG",
            status: 413,
            message: "Script source exceeds its byte budget",
          });
        const data = yield* read(env, capability.sandboxId, kernel, stat.path);
        const source = yield* Effect.try({
          try: () => new TextDecoder("utf-8", { fatal: true }).decode(data),
          catch: () =>
            new Fault({ code: "EILSEQ", status: 422, message: "Script source must be UTF-8" }),
        });
        if (action.op === "typescript.executeFile")
          return {
            language: "typescript" as const,
            mode: "module" as const,
            name: stat.path,
            source,
          };
        return {
          language: "javascript" as const,
          mode: "module" as const,
          name: stat.path,
          source,
        };
      }),
    ),
    Match.exhaustive,
  );
  const entry = yield* Schema.decodeUnknownEffect(SourceEntry)({
    language: root.language,
    name: root.name,
    source: root.source,
  });
  const modules = yield* graph(env, capability, kernel, entry, new Set(), root.mode);
  return Schema.decodeUnknownSync(ScriptProgram)({
    language: root.language,
    entry: root.name,
    mode: root.mode,
    modules,
  });
});

const SourceEntry = Schema.Struct({
  language: ScriptProgram.fields.language,
  name: Path,
  source: ModuleSource.fields.source,
});

const resolve = Effect.fn("modules.resolve")(function* (
  capability: typeof Capability.Type,
  kernel: Kernel,
  base: string,
  specifier: string,
  scheduled: ReadonlySet<string>,
) {
  yield* requirePermission(capability, "read");
  const local = yield* Effect.gen(function* () {
    if (!specifier.startsWith("file:")) return specifier;
    const url = yield* Effect.try({
      try: () => new URL(specifier),
      catch: () => new Fault({ code: "EINVAL", status: 422, message: "Invalid module URL" }),
    });
    if (url.host && url.host !== "localhost")
      return yield* new Fault({
        code: "FORBIDDEN",
        status: 403,
        message: "Remote file authorities are not allowed",
      });
    if (url.search || url.hash)
      return yield* new Fault({
        code: "ENOTSUP",
        status: 422,
        message: "Module URL query and fragment identities are not implemented",
      });
    return yield* Effect.try({
      try: () => decodeURIComponent(url.pathname),
      catch: () =>
        new Fault({ code: "EINVAL", status: 422, message: "Invalid module URL encoding" }),
    });
  });
  if (!local.startsWith("/") && !local.startsWith("./") && !local.startsWith("../"))
    return yield* new Fault({
      code: "MODULE_NOT_FOUND",
      status: 422,
      message: `Package or platform import is unavailable: ${specifier}`,
    });
  const parent = base.slice(0, base.lastIndexOf("/") + 1);
  const path = yield* kernelCall(() => kernel.canonical(local, parent));
  if (scheduled.has(path)) return { cached: true as const, path };
  const candidates = [path];
  if (!/\.(m?js|m?ts)$/.test(path))
    candidates.push(
      `${path}.js`,
      `${path}.mjs`,
      `${path}.ts`,
      `${path}/index.js`,
      `${path}/index.mjs`,
      `${path}/index.ts`,
    );
  const found: (typeof FileStat.Type)[] = [];
  while (candidates.length > 0 && found.length === 0) {
    const candidate = candidates.shift();
    if (candidate === undefined)
      return yield* new Fault({
        code: "INTERNAL",
        status: 500,
        message: "Missing module candidate",
      });
    const result = yield* kernelCall(() => kernel.stat(candidate, true)).pipe(Effect.result);
    if (result._tag === "Failure") {
      if (result.failure._tag === "Fault" && result.failure.code === "ENOENT") continue;
      return yield* result.failure;
    }
    const stat = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(FileStat))(result.success);
    if (stat.kind === "file") found.push(stat);
  }
  const stat = found[0];
  if (stat === undefined)
    return yield* new Fault({
      code: "MODULE_NOT_FOUND",
      status: 422,
      message: `Cannot resolve ${specifier} from ${base}`,
    });
  if (stat.size > 1_048_576)
    return yield* new Fault({
      code: "EFBIG",
      status: 413,
      message: "Module source exceeds its byte budget",
    });
  if (scheduled.has(stat.path)) return { cached: true as const, path: stat.path };
  return { cached: false as const, path: stat.path, stat };
});

const graph = Effect.fn("modules.graph")(function* (
  env: Env,
  capability: typeof Capability.Type,
  kernel: Kernel,
  root: typeof SourceEntry.Type,
  known: ReadonlySet<string>,
  mode: (typeof Header.Type)["mode"],
) {
  const queue = [root];
  const modules = new Map<string, typeof ModuleSource.Type>();
  const scheduled = new Set([...known, root.name]);
  const metadata = { language: root.language, entry: root.name, mode };
  const budget = {
    bytes:
      new TextEncoder().encode(Schema.encodeUnknownSync(Schema.fromJsonString(Header))(metadata))
        .byteLength + ',"modules":[]'.length,
  };
  while (queue.length > 0) {
    const next = queue.shift();
    if (next === undefined)
      return yield* new Fault({
        code: "INTERNAL",
        status: 500,
        message: "Missing scheduled module",
      });
    const compiled = yield* Effect.try({
      try: () => {
        const compiler = createBindings();
        compiler.initSync({ module: compilerWasm });
        if (next.language === "typescript") {
          const source = compiler.transpile(next.source);
          return compiler.compile_module(source, next.name);
        }
        return compiler.compile_module(next.source, next.name);
      },
      catch: (cause) => new Fault({ code: "COMPILE_FAILED", status: 422, message: String(cause) }),
    });
    const parsed = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(ModuleCompilation))(
      compiled,
    );
    const source = parsed.source;
    const names = parsed.imports;
    const edges = yield* Effect.forEach(names, (specifier) =>
      Effect.gen(function* () {
        const target = yield* resolve(capability, kernel, next.name, specifier, scheduled);
        if (target.cached) return { specifier, target: target.path };
        const stat = target.stat;
        if (!scheduled.has(stat.path)) {
          if (scheduled.size >= 128)
            return yield* new Fault({
              code: "EFBIG",
              status: 413,
              message: "Module graph exceeds its module budget",
            });
          const data = yield* read(env, capability.sandboxId, kernel, stat.path);
          const content = yield* Effect.try({
            try: () => new TextDecoder("utf-8", { fatal: true }).decode(data),
            catch: () =>
              new Fault({ code: "EILSEQ", status: 422, message: "Module source must be UTF-8" }),
          });
          scheduled.add(stat.path);
          if (/\.m?ts$/.test(stat.path))
            queue.push({
              language: "typescript",
              name: stat.path,
              source: content,
            });
          else
            queue.push({
              language: "javascript",
              name: stat.path,
              source: content,
            });
        }
        return { specifier, target: stat.path };
      }),
    );
    const module = { name: next.name, source, imports: edges };
    budget.bytes += new TextEncoder().encode(
      Schema.encodeSync(Schema.fromJsonString(ModuleSource))(module),
    ).byteLength;
    if (modules.size > 0) budget.bytes += 1;
    if (budget.bytes > 8_388_608)
      return yield* new Fault({
        code: "EFBIG",
        status: 413,
        message: "Serialized module graph exceeds its byte budget",
      });
    modules.set(next.name, module);
  }
  return Array.from(modules.values());
});

export const dynamic = Effect.fn("modules.dynamic")(function* (
  env: Env,
  capability: typeof Capability.Type,
  request: typeof ModuleRequest.Type,
) {
  const now = yield* Clock.currentTimeMillis;
  if (capability.expiresAt <= now)
    return yield* new Fault({ code: "UNAUTHORIZED", status: 401, message: "Capability expired" });
  const session = yield* open(env, capability.sandboxId);
  const known = new Set(request.known);
  const target = yield* resolve(capability, session.kernel, request.base, request.specifier, known);
  if (target.cached) return { entry: target.path, modules: [] };
  if (known.size >= 128)
    return yield* new Fault({
      code: "EFBIG",
      status: 413,
      message: "Module graph exceeds its module budget",
    });
  const data = yield* read(env, capability.sandboxId, session.kernel, target.path);
  const source = yield* Effect.try({
    try: () => new TextDecoder("utf-8", { fatal: true }).decode(data),
    catch: () => new Fault({ code: "EILSEQ", status: 422, message: "Module source must be UTF-8" }),
  });
  const language = Match.value(/\.m?ts$/.test(target.path)).pipe(
    Match.when(true, () => "typescript" as const),
    Match.orElse(() => "javascript" as const),
  );
  const modules = yield* graph(
    env,
    capability,
    session.kernel,
    { language, name: target.path, source },
    known,
    "module",
  );
  return Schema.decodeUnknownSync(ModuleBatch)({ entry: target.path, modules });
});
