import { Effect, Match, Schema, Struct } from "effect";
import compilerWasm from "cirro:compiler";
import { createBindings } from "../dist/compiler/bindings";
import {
  Capability,
  Fault,
  FileStat,
  ModuleImports,
  ModuleSource,
  RunAction,
  ScriptProgram,
} from "./contracts";
import { requirePermission } from "./auth";
import { kernelCall, read } from "./storage";
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
    action.op === "process.run" &&
    action.language !== "javascript" &&
    action.language !== "typescript"
  )
    return { language: action.language, source: action.source };
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
  const queue = [root];
  const modules = new Map<string, typeof ModuleSource.Type>();
  const scheduled = new Set([root.name]);
  const metadata = { language: root.language, entry: root.name, mode: root.mode };
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
          return { source, raw: compiler.imports(source) };
        }
        return { source: next.source, raw: compiler.imports(next.source) };
      },
      catch: (cause) => new Fault({ code: "COMPILE_FAILED", status: 422, message: String(cause) }),
    });
    const source = compiled.source;
    const names = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(ModuleImports))(
      compiled.raw,
    );
    const edges = yield* Effect.forEach(names, (specifier) =>
      Effect.gen(function* () {
        yield* requirePermission(capability, "read");
        if (
          !specifier.startsWith("/") &&
          !specifier.startsWith("./") &&
          !specifier.startsWith("../")
        )
          return yield* new Fault({
            code: "MODULE_NOT_FOUND",
            status: 422,
            message: `Package or platform import is unavailable: ${specifier}`,
          });
        const parent = next.name.slice(0, next.name.lastIndexOf("/") + 1);
        const path = yield* kernelCall(() => kernel.canonical(specifier, parent));
        if (scheduled.has(path)) return { specifier, target: path };
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
          const stat = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(FileStat))(
            result.success,
          );
          if (stat.kind === "file") found.push(stat);
        }
        const stat = found[0];
        if (stat === undefined)
          return yield* new Fault({
            code: "MODULE_NOT_FOUND",
            status: 422,
            message: `Cannot resolve ${specifier} from ${next.name}`,
          });
        if (stat.size > 1_048_576)
          return yield* new Fault({
            code: "EFBIG",
            status: 413,
            message: "Module source exceeds its byte budget",
          });
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
              mode: root.mode,
              name: stat.path,
              source: content,
            });
          else
            queue.push({
              language: "javascript",
              mode: root.mode,
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
  return Schema.decodeUnknownSync(ScriptProgram)({
    ...metadata,
    modules: Array.from(modules.values()),
  });
});
