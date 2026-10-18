import { Clock, Effect, Match, Option, Schema } from "effect";
import { requirePermission } from "./auth";
import {
  Capability,
  Environment,
  CommandArguments,
  DirectoryEntries,
  Fault,
  FileStat,
  RunResult,
  ShellPlan,
  ShellBuiltin,
  WasmProgram,
  WasmConfiguration,
} from "./contracts";
import { kernelCall, open, publish, read, write } from "./storage";
import { load } from "./modules";
import { Shell } from "../dist/kernel/cirro_kernel";
import { wasi } from "./wasi";
import type { OutputCapture } from "./output";
import type { Env } from "./resources";

const decodeBuiltin = Schema.decodeUnknownEffect(Schema.fromJsonString(ShellBuiltin));

export const shell = Effect.fn("shell.execute")(function* (
  env: Env,
  capability: typeof Capability.Type,
  source: string,
  environment: typeof Environment.Type,
  capture: OutputCapture,
) {
  const session = yield* open(env, capability.sandboxId);
  const kernel = session.kernel;
  const id = capability.sandboxId;
  const interpreter = yield* Effect.acquireRelease(
    kernelCall(
      () => new Shell(source, Schema.encodeSync(Schema.fromJsonString(Environment))(environment)),
    ),
    (interpreter) => Effect.sync(() => interpreter.free()),
  );
  const plan = yield* kernelCall(() => interpreter.plan()).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(ShellPlan))),
  );
  const dirty = new Set<string>();
  const state = yield* Effect.reduce(
    plan.entries(),
    () => ({
      cwd: "/home/cirro",
      exitCode: 0,
      pipelineStatus: 0,
      stdout: Buffer.alloc(0),
      stderr: Buffer.alloc(0),
      pipe: Buffer.alloc(0),
      pipelineSkipped: false,
      fatal: false,
    }),
    (state, [commandIndex, command]) =>
      Effect.gen(function* () {
        if (state.fatal) return state;
        if (command.gate === "pipe" && state.pipelineSkipped) return state;
        if (command.gate === "success" && state.exitCode !== 0)
          return { ...state, pipelineSkipped: true };
        if (command.gate === "failure" && state.exitCode === 0)
          return { ...state, pipelineSkipped: true };
        const now = yield* Clock.currentTimeNanos;
        yield* kernelCall(() => kernel.set_time(now));
        const expansionStatus = Match.value(command.gate).pipe(
          Match.when("pipe", () => state.pipelineStatus),
          Match.orElse(() => state.exitCode),
        );
        const expansion = yield* kernelCall(() =>
          interpreter.argv(commandIndex, expansionStatus),
        ).pipe(
          Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(CommandArguments))),
          Effect.result,
        );
        const argv = Match.value(expansion).pipe(
          Match.when({ _tag: "Success" }, (result) => result.success),
          Match.orElse(() => []),
        );
        const name = argv[0] ?? "true";
        const args = argv.slice(1);
        const cwd = state.cwd;
        const observed = { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
        const phase = { prepared: false };
        const hasOutput = command.redirects.some((redirect) => redirect.kind === "output");
        const redirected = {
          input: Option.none<bigint>(),
          output: { inode: Option.none<bigint>(), append: false },
          error: { inode: Option.none<bigint>(), append: false },
        };
        const commandOutcome = Effect.gen(function* () {
          yield* Effect.fromResult(expansion);
          const path = (input: string) => kernelCall(() => kernel.absolute(input, cwd));
          const file = Effect.fn("shell.read")(function* (input: string) {
            yield* requirePermission(capability, "read");
            const resolved = yield* path(input);
            const bytes = yield* read(env, id, kernel, resolved);
            return bytes;
          });
          yield* Effect.forEach(command.redirects, (redirect, redirectIndex) =>
            Effect.gen(function* () {
              const fields = yield* kernelCall(() =>
                interpreter.redirect(commandIndex, redirectIndex, expansionStatus),
              ).pipe(
                Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(CommandArguments))),
              );
              if (fields.length !== 1)
                return yield* new Fault({
                  code: "EINVAL",
                  status: 400,
                  message: "Ambiguous shell redirection",
                });
              if (fields[0] === "")
                return yield* new Fault({
                  code: "ENOENT",
                  status: 404,
                  message: "Empty shell redirection path",
                });
              const target = yield* path(fields[0]);
              if (redirect.kind === "input") {
                yield* requirePermission(capability, "read");
                yield* kernelCall(() => kernel.read_plan(target, 0n, 0n, false));
                const stat = yield* kernelCall(() => kernel.stat(target, true)).pipe(
                  Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(FileStat))),
                );
                redirected.input = Option.some(BigInt(stat.inode));
                return;
              }
              yield* requirePermission(capability, "write");
              const changed = yield* kernelCall(() => kernel.open_output(target, redirect.append));
              const stat = yield* kernelCall(() => kernel.stat(target, true)).pipe(
                Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(FileStat))),
              );
              if (changed) dirty.add(stat.path);
              redirected[redirect.kind].inode = Option.some(BigInt(stat.inode));
              redirected[redirect.kind].append = redirect.append;
            }),
          );
          const input = yield* Option.match(redirected.input, {
            onNone: () => Effect.succeed(state.pipe),
            onSome: (inode) => read(env, id, kernel, inode),
          });
          phase.prepared = true;
          const builtin = yield* Match.value(
            argv.length === 0 || [":", "export", "unset", "readonly"].includes(name),
          ).pipe(
            Match.when(true, () =>
              kernelCall(() => interpreter.commit(commandIndex)).pipe(
                Effect.flatMap(decodeBuiltin),
              ),
            ),
            Match.orElse(() => Effect.succeed(null)),
          );
          const external = yield* Effect.gen(function* () {
            if (builtin !== null || ["", "cd", "pwd", "echo", "true", "false"].includes(name))
              return null;
            const path = yield* kernelCall(() => interpreter.path());
            return yield* kernelCall(() => kernel.command_path(name, cwd, path)).pipe(
              Effect.catchTag("Fault", (fault) => {
                if (fault.code === "ENOENT") return Effect.succeed(null);
                return Effect.fail(fault);
              }),
            );
          });
          const result = yield* Effect.gen(function* () {
            if (builtin !== null) return builtin;
            if (name === "") return { stdout: "", stderr: ": command not found\n", exitCode: 127 };
            if (external !== null) {
              const commandEnvironment = yield* kernelCall(() => interpreter.environment()).pipe(
                Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(Environment))),
              );
              const program = yield* load(
                env,
                capability,
                kernel,
                {
                  op: "process.execFile",
                  id: "shell-command",
                  command: external,
                  args,
                  stdin: { content: input.toString("base64"), encoding: "base64" },
                },
                commandEnvironment,
              ).pipe(Effect.flatMap(Schema.decodeUnknownEffect(WasmProgram)));
              const before = session.etag;
              const commandCapture: OutputCapture = (stdio, observeCancellation) => {
                if (typeof stdio.stdout === "string")
                  observed.stdout = Buffer.from(stdio.stdout, "utf8");
                else observed.stdout = Buffer.from(stdio.stdout);
                if (typeof stdio.stderr === "string")
                  observed.stderr = Buffer.from(stdio.stderr, "utf8");
                else observed.stderr = Buffer.from(stdio.stderr);
                const stdout = Match.value(command.pipe || hasOutput).pipe(
                  Match.when(true, () => state.stdout),
                  Match.orElse(() => Buffer.concat([state.stdout, observed.stdout])),
                );
                const stderr = Match.value(Option.isSome(redirected.error.inode)).pipe(
                  Match.when(true, () => state.stderr),
                  Match.orElse(() => Buffer.concat([state.stderr, observed.stderr])),
                );
                if (stdout.length + stderr.length > session.head.policy.maxOutputBytes)
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
                Effect.map((result) => ({
                  ...result,
                  stdout: observed.stdout,
                  stderr: observed.stderr,
                })),
                Effect.catchTag("WasmFailure", () =>
                  Effect.succeed({
                    stdout: observed.stdout,
                    stderr: Buffer.concat([
                      observed.stderr,
                      Buffer.from(`${name}: WASI execution failed\n`),
                    ]),
                    exitCode: 126,
                  }),
                ),
                Effect.ensuring(
                  Effect.sync(() => {
                    if (session.etag !== before) dirty.clear();
                  }),
                ),
              );
            }
            if (name.includes("/"))
              return { stdout: "", stderr: `${name}: command not found\n`, exitCode: 127 };
            if (name === "cat") {
              const paths = yield* Effect.forEach(
                args,
                (input) =>
                  Effect.gen(function* () {
                    yield* requirePermission(capability, "read");
                    const resolved = yield* path(input);
                    const stat = yield* kernelCall(() => kernel.stat(resolved, true)).pipe(
                      Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(FileStat))),
                    );
                    return { path: resolved, size: stat.size };
                  }),
                { concurrency: 4 },
              );
              if (
                paths.reduce((total, entry) => total + entry.size, 0) >
                session.head.policy.maxOutputBytes
              )
                return yield* new Fault({
                  code: "EFBIG",
                  status: 413,
                  message: "cat output exceeds the command byte quota",
                });
              const inputs = yield* Effect.forEach(paths, (entry) => file(entry.path), {
                concurrency: 4,
              });
              if (inputs.length === 0)
                return { stdout: input, stderr: Buffer.alloc(0), exitCode: 0 };
              return { stdout: Buffer.concat(inputs), stderr: Buffer.alloc(0), exitCode: 0 };
            }
            return yield* Match.value(name).pipe(
              Match.when("pwd", () =>
                Effect.succeed({ stdout: `${cwd}\n`, stderr: "", exitCode: 0 }),
              ),
              Match.when("whoami", () =>
                Effect.succeed({ stdout: "cirro\n", stderr: "", exitCode: 0 }),
              ),
              Match.when("cd", () =>
                Effect.gen(function* () {
                  const home = yield* kernelCall(() => interpreter.home());
                  const target = yield* path(args[0] ?? home);
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
                Effect.scoped(
                  Effect.gen(function* () {
                    const result = yield* Effect.acquireRelease(
                      kernelCall(() =>
                        kernel.byte_command(
                          name,
                          Schema.encodeSync(Schema.fromJsonString(CommandArguments))(args),
                          input,
                        ),
                      ),
                      (result) => Effect.sync(() => result.free()),
                    );
                    return {
                      stdout: result.stdout,
                      stderr: result.stderr,
                      exitCode: result.exitCode,
                    };
                  }),
                ),
              ),
            );
          });
          const bytes = {
            ...result,
            stdout: yield* Effect.sync(() => {
              if (typeof result.stdout === "string") return Buffer.from(result.stdout, "utf8");
              return Buffer.from(result.stdout);
            }),
            stderr: yield* Effect.sync(() => {
              if (typeof result.stderr === "string") return Buffer.from(result.stderr, "utf8");
              return Buffer.from(result.stderr);
            }),
          };
          if (bytes.stdout.length + bytes.stderr.length > session.head.policy.maxOutputBytes)
            return yield* new Fault({
              code: "EFBIG",
              status: 413,
              message: "Command output limit exceeded",
            });
          return bytes;
        });
        const failed = Effect.fn("shell.commandFailure")(function* (fault: Fault) {
          if (
            fault.code === "CONFLICT" ||
            fault.code === "UNAUTHORIZED" ||
            fault.code === "ECANCELED"
          )
            return yield* Effect.fail(fault);
          const exitCode = Match.value(fault.code).pipe(
            Match.when("READONLY", () => 2),
            Match.orElse(() =>
              Match.value(phase.prepared).pipe(
                Match.when(false, () => 1),
                Match.orElse(() =>
                  Match.value(fault.code).pipe(
                    Match.when("ENOENT", () => 127),
                    Match.when("EACCES", () => 126),
                    Match.orElse(() => 1),
                  ),
                ),
              ),
            ),
          );
          return {
            fatal: fault.code === "READONLY" && !command.pipe && command.gate !== "pipe",
            stdout: Match.value(hasOutput).pipe(
              Match.when(true, () => Buffer.alloc(0)),
              Match.orElse(() => observed.stdout),
            ),
            stderr: Buffer.concat([observed.stderr, Buffer.from(`${name}: ${fault.message}\n`)]),
            exitCode,
          };
        });
        const result = yield* commandOutcome.pipe(Effect.catchTag("Fault", failed));
        const outcome = yield* Effect.gen(function* () {
          if (result.stdout.length + result.stderr.length > session.head.policy.maxOutputBytes)
            return yield* new Fault({
              code: "EFBIG",
              status: 413,
              message: "Command output limit exceeded",
            });
          yield* Effect.forEach(
            [
              { stream: "stdout", target: redirected.output },
              { stream: "stderr", target: redirected.error },
            ] as const,
            ({ stream, target }) =>
              Effect.gen(function* () {
                if (Option.isNone(target.inode)) return;
                const inode = target.inode.value;
                const remaining = yield* kernelCall(() => kernel.inode_path(inode));
                const bytes = result[stream];
                if (remaining === undefined || bytes.length === 0) return;
                const before = yield* read(env, id, kernel, inode);
                const data = yield* Effect.sync(() => {
                  if (target.append) return Buffer.concat([before, bytes]);
                  if (before.length <= bytes.length) return bytes;
                  bytes.copy(before);
                  return before;
                });
                yield* write(env, id, kernel, inode, data);
                dirty.add(remaining);
              }),
          );
          return {
            ...result,
            stdout: Match.value(Option.isSome(redirected.output.inode)).pipe(
              Match.when(true, () => Buffer.alloc(0)),
              Match.orElse(() => result.stdout),
            ),
            stderr: Match.value(Option.isSome(redirected.error.inode)).pipe(
              Match.when(true, () => Buffer.alloc(0)),
              Match.orElse(() => result.stderr),
            ),
          };
        }).pipe(Effect.catchTag("Fault", failed));
        const nextCwd = Match.value(
          !command.pipe && command.gate !== "pipe" && "cwd" in outcome,
        ).pipe(
          Match.when(true, () => {
            if ("cwd" in outcome && Schema.is(Schema.String)(outcome.cwd)) return outcome.cwd;
            return cwd;
          }),
          Match.orElse(() => cwd),
        );
        const stdout = Match.value(command.pipe).pipe(
          Match.when(true, () => state.stdout),
          Match.orElse(() => Buffer.concat([state.stdout, outcome.stdout])),
        );
        const stderr = Buffer.concat([state.stderr, outcome.stderr]);
        if (stdout.length + stderr.length > session.head.policy.maxOutputBytes)
          return yield* new Fault({
            code: "EFBIG",
            status: 413,
            message: "Shell output limit exceeded",
          });
        const pipe = Match.value(command.pipe).pipe(
          Match.when(true, () => outcome.stdout),
          Match.orElse(() => Buffer.alloc(0)),
        );
        yield* capture({ stdout, stderr });
        const fatal = "fatal" in outcome && outcome.fatal === true;
        return {
          cwd: nextCwd,
          fatal,
          pipelineStatus: expansionStatus,
          stdout,
          stderr,
          exitCode: Match.value(command.negate && !command.pipe && !fatal).pipe(
            Match.when(true, () => {
              if (outcome.exitCode === 0) return 1;
              return 0;
            }),
            Match.orElse(() => outcome.exitCode),
          ),
          pipe,
          pipelineSkipped: false,
        };
      }),
  );
  if (dirty.size > 0) yield* publish(env, id, session);
  return {
    stdout: state.stdout.toString("utf8"),
    stderr: state.stderr.toString("utf8"),
    result: null,
    exitCode: state.exitCode,
  } satisfies typeof RunResult.Type;
}, Effect.scoped);
