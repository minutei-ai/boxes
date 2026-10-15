import { Effect, Option, Schema } from "effect";
import { Capability, CommandArguments, Fault, FileStat, WasmConfiguration } from "./contracts";
import { kernelCall, read } from "./storage";
import wasmModuleBytes from "./wasm-module-bytes.json";
import type { Kernel } from "../dist/kernel/cirro_kernel";
import type { Env } from "./resources";

export const loadExecutable = Effect.fn("executable.load")(function* (
  env: Env,
  capability: typeof Capability.Type,
  kernel: Kernel,
  entry: string,
  argv: typeof WasmConfiguration.Type.argv,
  cwd: string,
) {
  const initialPath = yield* kernelCall(() => kernel.canonical(entry, cwd));
  const result = yield* Effect.reduce(
    [0, 1, 2, 3, 4],
    () => ({ entry: initialPath, argv, bytes: Option.none<Buffer>() }),
    (state, depth) =>
      Effect.gen(function* () {
        if (Option.isSome(state.bytes)) return state;
        const stat = yield* kernelCall(() => kernel.stat(state.entry, true)).pipe(
          Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(FileStat))),
        );
        if (stat.kind !== "file" || (stat.mode & 0o111) === 0)
          return yield* new Fault({
            code: "EACCES",
            status: 403,
            message: "Executable image is not executable",
          });
        if (stat.size > wasmModuleBytes)
          return yield* new Fault({
            code: "EFBIG",
            status: 413,
            message: "Executable exceeds its module byte limit",
          });
        const data = yield* read(env, capability.sandboxId, kernel, state.entry);
        if (data.subarray(0, 4).equals(Buffer.from([0, 97, 115, 109])))
          return { ...state, bytes: Option.some(data) };
        if (depth === 4)
          return yield* new Fault({
            code: "ELOOP",
            status: 400,
            message: "Interpreter nesting exceeds four scripts",
          });
        const header = yield* kernelCall(() =>
          kernel.interpreter_arguments(data.subarray(0, 257)),
        ).pipe(
          Effect.flatMap(
            Schema.decodeUnknownEffect(
              Schema.fromJsonString(
                CommandArguments.check(Schema.isMinLength(1), Schema.isMaxLength(2)),
              ),
            ),
          ),
        );
        const interpreter = yield* kernelCall(() => kernel.canonical(header[0], cwd));
        const resolved = yield* kernelCall(() => kernel.command_path(interpreter, cwd, ""));
        const arguments_ = [resolved, ...header.slice(1), state.entry, ...state.argv.slice(1)];
        if (arguments_.length > 129)
          return yield* new Fault({
            code: "E2BIG",
            status: 413,
            message: "Interpreter arguments exceed the process argument limit",
          });
        if (arguments_.some((value) => !value.isWellFormed() || Buffer.byteLength(value) > 4096))
          return yield* new Fault({
            code: "EINVAL",
            status: 400,
            message: "Interpreter argv exceeds its UTF-8 argument limit",
          });
        return { entry: resolved, argv: arguments_, bytes: Option.none<Buffer>() };
      }),
  );
  const bytes = yield* Option.match(result.bytes, {
    onSome: Effect.succeed,
    onNone: () =>
      Effect.fail(
        new Fault({
          code: "ELOOP",
          status: 400,
          message: "Interpreter nesting exceeds four scripts",
        }),
      ),
  });
  return { entry: result.entry, argv: result.argv, bytes };
});
