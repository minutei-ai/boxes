import { Clock, Effect, Match, Schema } from "effect";
import { requirePermission } from "./auth";
import {
  Capability,
  CommandArguments,
  CommandOutput,
  DirectoryEntries,
  Fault,
  FileStat,
  RunResult,
  ShellPlan,
  WasmProgram,
  WasmConfiguration,
} from "./contracts";
import { kernelCall, open, publish, read, write } from "./storage";
import { load } from "./modules";
import { wasi } from "./wasi";
import type { OutputCapture } from "./output";
import type { Env } from "./resources";

export const shell = Effect.fn("shell.execute")(function* (
  env: Env,
  capability: typeof Capability.Type,
  source: string,
  capture: OutputCapture,
) {
  const session = yield* open(env, capability.sandboxId);
  const kernel = session.kernel;
  const id = capability.sandboxId;
  const plan = yield* kernelCall(() => kernel.shell_plan(source)).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(ShellPlan))),
  );
  const environment = yield* kernelCall(() => kernel.package_environment()).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(WasmConfiguration.fields.env))),
  );
  const dirty = new Set<string>();
  const state = yield* Effect.reduce(
    plan,
    () => ({ cwd: "/home/cirro", exitCode: 0, stdout: "", stderr: "", pipe: "" }),
    (state, command) =>
      Effect.gen(function* () {
        if (command.gate === "success" && state.exitCode !== 0) return state;
        if (command.gate === "failure" && state.exitCode === 0) return state;
        const now = yield* Clock.currentTimeNanos;
        yield* kernelCall(() => kernel.set_time(now));
        const name = command.argv[0];
        const args = command.argv.slice(1);
        const cwd = state.cwd;
        const outcome = yield* Effect.gen(function* () {
          const path = (input: string) => kernelCall(() => kernel.canonical(input, cwd));
          const text = Effect.fn("shell.read")(function* (input: string) {
            yield* requirePermission(capability, "read");
            const resolved = yield* path(input);
            const bytes = yield* read(env, id, kernel, resolved);
            return bytes.toString("utf8");
          });
          const input = yield* Effect.gen(function* () {
            if (command.input !== null) return yield* text(command.input);
            return state.pipe;
          });
          const external = yield* Effect.gen(function* () {
            if (["cd", "pwd", "echo", "true", "false"].includes(name)) return null;
            return yield* kernelCall(() =>
              kernel.command_path(
                name,
                cwd,
                environment.PATH ?? "/opt/cirro/bin:/usr/local/bin:/usr/bin:/bin",
              ),
            ).pipe(
              Effect.catchTag("Fault", (fault) => {
                if (fault.code === "ENOENT") return Effect.succeed(null);
                return Effect.fail(fault);
              }),
            );
          });
          const result = yield* Effect.gen(function* () {
            if (external !== null) {
              const program = yield* load(env, capability, kernel, {
                op: "process.execFile",
                id: "shell-command",
                command: external,
                args,
                stdin: { content: input, encoding: "utf8" },
              }).pipe(Effect.flatMap(Schema.decodeUnknownEffect(WasmProgram)));
              const before = session.etag;
              const commandCapture: OutputCapture = (stdio, observeCancellation) => {
                const stdout = Match.value(command.pipe || command.output !== null).pipe(
                  Match.when(true, () => state.stdout),
                  Match.orElse(() => {
                    if (typeof stdio.stdout === "string") return state.stdout + stdio.stdout;
                    return state.stdout + Buffer.from(stdio.stdout).toString("utf8");
                  }),
                );
                const stderr = Match.value(stdio.stderr).pipe(
                  Match.when(Match.string, (value) => state.stderr + value),
                  Match.orElse((value) => state.stderr + Buffer.from(value).toString("utf8")),
                );
                if (
                  Buffer.byteLength(stdout) + Buffer.byteLength(stderr) >
                  session.head.policy.maxOutputBytes
                )
                  return Effect.fail(
                    new Fault({
                      code: "EFBIG",
                      status: 413,
                      message: "Shell output limit exceeded",
                    }),
                  );
                return capture({ stdout, stderr }, observeCancellation);
              };
              return yield* wasi(
                env,
                capability,
                program,
                session,
                commandCapture,
                null,
                null,
                false,
              ).pipe(
                Effect.ensuring(
                  Effect.sync(() => {
                    if (session.etag !== before) dirty.clear();
                  }),
                ),
              );
            }
            if (name.includes("/"))
              return { stdout: "", stderr: `${name}: command not found\n`, exitCode: 127 };
            return yield* Match.value(name).pipe(
              Match.when("pwd", () =>
                Effect.succeed({ stdout: `${cwd}\n`, stderr: "", exitCode: 0 }),
              ),
              Match.when("whoami", () =>
                Effect.succeed({ stdout: "cirro\n", stderr: "", exitCode: 0 }),
              ),
              Match.when("cd", () =>
                Effect.gen(function* () {
                  const target = yield* path(args[0] ?? "/home/cirro");
                  const stat = yield* kernelCall(() => kernel.stat(target, true)).pipe(
                    Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(FileStat))),
                  );
                  if (stat.kind !== "directory")
                    return yield* new Fault({
                      code: "ENOTDIR",
                      status: 400,
                      message: "cd requires a directory",
                    });
                  return { stdout: "", stderr: "", exitCode: 0, cwd: stat.path };
                }),
              ),
              Match.when("ls", () =>
                Effect.gen(function* () {
                  yield* requirePermission(capability, "read");
                  if (args.length > 1 || args.some((arg) => arg.startsWith("-")))
                    return yield* new Fault({
                      code: "ENOTSUP",
                      status: 400,
                      message: "ls accepts one directory path",
                    });
                  const target = yield* path(args[0] ?? cwd);
                  const entries = yield* kernelCall(() => kernel.readdir(target)).pipe(
                    Effect.flatMap(
                      Schema.decodeUnknownEffect(Schema.fromJsonString(DirectoryEntries)),
                    ),
                  );
                  return {
                    stdout: entries.map((entry) => `${entry.name}\n`).join(""),
                    stderr: "",
                    exitCode: 0,
                  };
                }),
              ),
              Match.when("mkdir", () =>
                Effect.gen(function* () {
                  yield* requirePermission(capability, "write");
                  const recursive = args[0] === "-p";
                  const paths = Match.value(recursive).pipe(
                    Match.when(true, () => args.slice(1)),
                    Match.orElse(() => args),
                  );
                  if (paths.length === 0)
                    return yield* new Fault({
                      code: "EINVAL",
                      status: 400,
                      message: "mkdir requires a path",
                    });
                  yield* Effect.forEach(
                    paths,
                    (input) =>
                      Effect.gen(function* () {
                        const target = yield* path(input);
                        yield* kernelCall(() => kernel.mkdir(target, recursive));
                        dirty.add(target);
                      }),
                    { concurrency: 1 },
                  );
                  return { stdout: "", stderr: "", exitCode: 0 };
                }),
              ),
              Match.when("rm", () =>
                Effect.gen(function* () {
                  yield* requirePermission(capability, "write");
                  const recursive = args[0] === "-r" || args[0] === "-rf";
                  const paths = Match.value(recursive).pipe(
                    Match.when(true, () => args.slice(1)),
                    Match.orElse(() => args),
                  );
                  if (paths.length === 0)
                    return yield* new Fault({
                      code: "EINVAL",
                      status: 400,
                      message: "rm requires a path",
                    });
                  yield* Effect.forEach(
                    paths,
                    (input) =>
                      Effect.gen(function* () {
                        const target = yield* path(input);
                        yield* kernelCall(() => kernel.remove(target, recursive));
                        dirty.add(target);
                      }),
                    { concurrency: 1 },
                  );
                  return { stdout: "", stderr: "", exitCode: 0 };
                }),
              ),
              Match.when("mv", () =>
                Effect.gen(function* () {
                  yield* requirePermission(capability, "write");
                  if (args.length !== 2)
                    return yield* new Fault({
                      code: "EINVAL",
                      status: 400,
                      message: "mv requires source and destination",
                    });
                  const from = yield* path(args[0]);
                  const to = yield* path(args[1]);
                  yield* kernelCall(() => kernel.rename(from, to));
                  dirty.add(to);
                  return { stdout: "", stderr: "", exitCode: 0 };
                }),
              ),
              Match.when("cp", () =>
                Effect.gen(function* () {
                  yield* requirePermission(capability, "read");
                  yield* requirePermission(capability, "write");
                  if (args.length !== 2)
                    return yield* new Fault({
                      code: "EINVAL",
                      status: 400,
                      message: "cp requires source and destination",
                    });
                  const from = yield* path(args[0]);
                  const to = yield* path(args[1]);
                  const data = yield* read(env, id, kernel, from);
                  yield* write(env, id, kernel, to, data);
                  dirty.add(to);
                  return { stdout: "", stderr: "", exitCode: 0 };
                }),
              ),
              Match.orElse(() =>
                Effect.gen(function* () {
                  const content = yield* Effect.gen(function* () {
                    if (name === "cat" && args.length > 0)
                      return (yield* Effect.forEach(args, text, { concurrency: 4 })).join("");
                    return input;
                  });
                  const commandArgs = Match.value(name === "cat").pipe(
                    Match.when(true, () => []),
                    Match.orElse(() => args),
                  );
                  const json = yield* kernelCall(() =>
                    kernel.text_command(
                      name,
                      Schema.encodeSync(Schema.fromJsonString(CommandArguments))(commandArgs),
                      content,
                    ),
                  );
                  return yield* Schema.decodeUnknownEffect(Schema.fromJsonString(CommandOutput))(
                    json,
                  );
                }),
              ),
            );
          });
          if (command.output !== null) {
            yield* requirePermission(capability, "write");
            const target = yield* path(command.output);
            const prefix = yield* Effect.gen(function* () {
              if (!command.append) return Buffer.alloc(0);
              yield* requirePermission(capability, "read");
              return yield* read(env, id, kernel, target).pipe(
                Effect.catchTag("Fault", (fault) => {
                  if (fault.code === "ENOENT") return Effect.succeed(Buffer.alloc(0));
                  return Effect.fail(fault);
                }),
              );
            });
            yield* write(
              env,
              id,
              kernel,
              target,
              Buffer.concat([prefix, Buffer.from(result.stdout)]),
            );
            dirty.add(target);
            return { ...result, stdout: "" };
          }
          return result;
        }).pipe(
          Effect.catchTag("Fault", (fault) => {
            if (
              fault.code === "CONFLICT" ||
              fault.code === "UNAUTHORIZED" ||
              fault.code === "ECANCELED"
            )
              return Effect.fail(fault);
            const exitCode = Match.value(fault.code).pipe(
              Match.when("ENOENT", () => 127),
              Match.when("EACCES", () => 126),
              Match.orElse(() => 1),
            );
            return Effect.succeed({ stdout: "", stderr: `${name}: ${fault.message}\n`, exitCode });
          }),
          Effect.catchTag("WasmFailure", () =>
            Effect.succeed({
              stdout: "",
              stderr: `${name}: WASI execution failed\n`,
              exitCode: 126,
            }),
          ),
        );
        const nextCwd = Match.value("cwd" in outcome).pipe(
          Match.when(true, () => {
            if ("cwd" in outcome && Schema.is(Schema.String)(outcome.cwd)) return outcome.cwd;
            return cwd;
          }),
          Match.orElse(() => cwd),
        );
        const stdout = Match.value(command.pipe).pipe(
          Match.when(true, () => state.stdout),
          Match.orElse(() => state.stdout + outcome.stdout),
        );
        const stderr = state.stderr + outcome.stderr;
        if (
          Buffer.byteLength(stdout) + Buffer.byteLength(stderr) >
          session.head.policy.maxOutputBytes
        )
          return yield* new Fault({
            code: "EFBIG",
            status: 413,
            message: "Shell output limit exceeded",
          });
        const pipe = Match.value(command.pipe).pipe(
          Match.when(true, () => outcome.stdout),
          Match.orElse(() => ""),
        );
        yield* capture({ stdout, stderr });
        return { cwd: nextCwd, stdout, stderr, exitCode: outcome.exitCode, pipe };
      }),
  );
  if (dirty.size > 0) yield* publish(env, id, session);
  return {
    stdout: state.stdout,
    stderr: state.stderr,
    result: null,
    exitCode: state.exitCode,
  } satisfies typeof RunResult.Type;
});
