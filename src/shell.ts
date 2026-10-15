import { Clock, Effect, Match, Schema } from "effect";
import { requirePermission } from "./auth";
import {
  Capability,
  CommandArguments,
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
    () => ({
      cwd: "/home/cirro",
      exitCode: 0,
      stdout: Buffer.alloc(0),
      stderr: Buffer.alloc(0),
      pipe: Buffer.alloc(0),
      pipelineSkipped: false,
    }),
    (state, command) =>
      Effect.gen(function* () {
        if (command.gate === "pipe" && state.pipelineSkipped) return state;
        if (command.gate === "success" && state.exitCode !== 0)
          return { ...state, pipelineSkipped: true };
        if (command.gate === "failure" && state.exitCode === 0)
          return { ...state, pipelineSkipped: true };
        const now = yield* Clock.currentTimeNanos;
        yield* kernelCall(() => kernel.set_time(now));
        const name = command.argv[0];
        const args = command.argv.slice(1);
        const cwd = state.cwd;
        const observed = { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
        const outcome = yield* Effect.gen(function* () {
          const path = (input: string) => kernelCall(() => kernel.canonical(input, cwd));
          const file = Effect.fn("shell.read")(function* (input: string) {
            yield* requirePermission(capability, "read");
            const resolved = yield* path(input);
            const bytes = yield* read(env, id, kernel, resolved);
            return bytes;
          });
          const input = yield* Effect.gen(function* () {
            if (command.input !== null) return yield* file(command.input);
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
                stdin: { content: input.toString("base64"), encoding: "base64" },
              }).pipe(Effect.flatMap(Schema.decodeUnknownEffect(WasmProgram)));
              const before = session.etag;
              const commandCapture: OutputCapture = (stdio, observeCancellation) => {
                if (typeof stdio.stdout === "string")
                  observed.stdout = Buffer.from(stdio.stdout, "utf8");
                else observed.stdout = Buffer.from(stdio.stdout);
                if (typeof stdio.stderr === "string")
                  observed.stderr = Buffer.from(stdio.stderr, "utf8");
                else observed.stderr = Buffer.from(stdio.stderr);
                const stdout = Match.value(command.pipe || command.output !== null).pipe(
                  Match.when(true, () => state.stdout),
                  Match.orElse(() => Buffer.concat([state.stdout, observed.stdout])),
                );
                const stderr = Buffer.concat([state.stderr, observed.stderr]);
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
            yield* write(env, id, kernel, target, Buffer.concat([prefix, bytes.stdout]));
            dirty.add(target);
            return { ...bytes, stdout: Buffer.alloc(0) };
          }
          return bytes;
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
            return Effect.succeed({
              stdout: observed.stdout,
              stderr: Buffer.concat([observed.stderr, Buffer.from(`${name}: ${fault.message}\n`)]),
              exitCode,
            });
          }),
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
        return {
          cwd: nextCwd,
          stdout,
          stderr,
          exitCode: Match.value(command.negate && !command.pipe).pipe(
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
});
