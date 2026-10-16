import {
  Clock,
  Deferred,
  Duration,
  Effect,
  Exit,
  Fiber,
  Match,
  Schema,
  Scope,
  Semaphore,
  Schedule,
  Struct,
} from "effect";
import wasm from "cirro:wasi";
import { createBindings } from "../dist/wasi/bindings";
import { requirePermission } from "./auth";
import { loadExecutable } from "./executable";
import {
  Capability,
  Fault,
  FileStat,
  DirectoryEntries,
  RunResult,
  WasmStep,
  WasiOpen,
  SpawnStageResult,
  WasmProgram,
  WasmConfiguration,
  StoredRun,
} from "./contracts";
import type { open } from "./storage";
import {
  CheckpointReady,
  saveHeap,
  restoreHeap,
  saveExecutionCheckpoint,
  restoreExecutionCheckpoint,
} from "./checkpoint";
import { initializeInput, readInput, finishInput } from "./input";
import { kernelCall, publish, read, write, StorageFailure } from "./storage";
import type { Kernel } from "../dist/kernel/cirro_kernel";
import type { OutputCapture } from "./output";
import type { Env } from "./resources";

export class WasmFailure extends Schema.TaggedError<WasmFailure>()("WasmFailure", {
  cause: Schema.Unknown,
}) {}

const statBytes = (stat: typeof FileStat.Type) => {
  const bytes = Buffer.alloc(76);
  bytes.writeBigUInt64LE(BigInt(stat.inode), 8);
  bytes[16] = Match.value(stat.kind).pipe(
    Match.when("file", () => 4),
    Match.when("directory", () => 3),
    Match.orElse(() => 7),
  );
  bytes.writeBigUInt64LE(BigInt(stat.nlink), 24);
  bytes.writeBigUInt64LE(BigInt(stat.size), 32);
  bytes.writeBigUInt64LE(BigInt(stat.atimeNs), 40);
  bytes.writeBigUInt64LE(BigInt(stat.mtimeNs), 48);
  bytes.writeBigUInt64LE(BigInt(stat.ctimeNs), 56);
  const kind = Match.value(stat.kind).pipe(
    Match.when("file", () => 0o100000),
    Match.when("directory", () => 0o40000),
    Match.when("symlink", () => 0o120000),
    Match.exhaustive,
  );
  bytes.writeUInt32LE(kind | stat.mode, 64);
  bytes.writeUInt32LE(stat.uid, 68);
  bytes.writeUInt32LE(stat.gid, 72);
  return bytes;
};

const resolvePath = Effect.fn("wasi.resolvePath")(function* (
  kernel: Kernel,
  path: string,
  base: string,
  follow = false,
) {
  const parent = path.slice(0, path.lastIndexOf("/"));
  const directory = yield* kernelCall(() => kernel.realpath(parent || "/"));
  const leaf = path.slice(path.lastIndexOf("/"));
  const resolved = Match.value(directory).pipe(
    Match.when("/", () => leaf),
    Match.orElse(() => directory + leaf),
  );
  const canonical = yield* Effect.gen(function* () {
    if (follow) return yield* kernelCall(() => kernel.realpath(resolved));
    return resolved;
  });
  if (base !== "/" && canonical !== base && !canonical.startsWith(base + "/"))
    return yield* new Fault({
      code: "ENOTCAPABLE",
      status: 403,
      message: "WASI path escapes its directory descriptor",
    });
  return canonical;
});

export const wasi = Effect.fn("wasi.execute")(function* (
  env: Env,
  capability: typeof Capability.Type,
  program: typeof WasmProgram.Type,
  initial: Effect.Success<ReturnType<typeof open>>,
  capture: OutputCapture | null,
  inputId: string | null,
  checkpointReference: string | null,
  canHandover: boolean,
  stdinMode: typeof StoredRun.Type.stdinMode = "closed",
) {
  const handoverAt = (yield* Clock.currentTimeMillis) + 30_000;
  const policy = initial.head.policy;
  const restored = yield* Effect.gen(function* () {
    if (checkpointReference === null) return null;
    return yield* restoreExecutionCheckpoint(
      env.OBJECTS,
      capability.sandboxId,
      checkpointReference,
    );
  });
  const native = yield* Effect.gen(function* () {
    if (restored !== null)
      return yield* restoreHeap(env.OBJECTS, capability.sandboxId, restored.heap);
    const bindings = createBindings();
    const exports = bindings.initSync({ module: wasm });
    return { bindings, exports, handles: [] };
  });
  const transferred = new WeakSet<InstanceType<ReturnType<typeof createBindings>["WasmGuest"]>>();
  const parking = { active: false };
  const rootHandle = native.handles.find((item) => item.pid === 1);
  if (restored !== null && rootHandle === undefined)
    return yield* new WasmFailure({ cause: "Checkpoint has no root handle" });
  const guest = yield* Effect.acquireRelease(
    Effect.try({
      try: () => {
        if (rootHandle !== undefined) return native.bindings.WasmGuest.resume(rootHandle.handle);
        const stdin = Match.value(inputId).pipe(
          Match.when(null, () => Buffer.from(program.stdin, "base64")),
          Match.orElse(() => Buffer.alloc(0)),
        );
        return new native.bindings.WasmGuest(
          Buffer.from(program.source, "base64"),
          Schema.encodeSync(
            Schema.fromJsonString(
              WasmConfiguration.mapFields((fields) => Struct.omit(fields, ["stdin"])),
            ),
          )(program),
          stdin,
          policy.memoryBytes,
          BigInt(policy.interruptBudget) * 1000n,
          policy.maxOutputBytes,
        );
      },
      catch: (cause) => new WasmFailure({ cause }),
    }),
    (guest) =>
      Effect.sync(() => {
        if (!transferred.has(guest)) guest.free();
      }),
  );
  const live = new Map<number, InstanceType<ReturnType<typeof createBindings>["WasmGuest"]>>([
    [1, guest],
  ]);
  const clocks = { offset: 0n };
  if (restored !== null) {
    yield* kernelCall(() => initial.kernel.resume_manifest(restored.manifest));
    initial.head = restored.head;
    initial.etag = restored.etag;
    const now = yield* Clock.currentTimeMillis;
    const monotonic = yield* Clock.monotonicTimeNanos;
    clocks.offset =
      BigInt(restored.monotonic) +
      BigInt(Math.max(0, now - restored.savedAt)) * 1_000_000n -
      monotonic;
  }
  if (inputId !== null && stdinMode === "closed")
    return yield* new WasmFailure({ cause: "Interactive process has closed input mode" });
  if (inputId !== null && restored === null && stdinMode !== "closed") {
    yield* initializeInput(
      env,
      capability.sandboxId,
      inputId,
      Buffer.from(program.stdin, "base64"),
      stdinMode,
    );
    yield* Effect.try({
      try: () => {
        if (stdinMode === "pty") return guest.enable_terminal();
        return guest.enable_stdin();
      },
      catch: (cause) => new WasmFailure({ cause }),
    });
  }
  if (inputId !== null && stdinMode === "pty") {
    const control = yield* readInput(env, capability.sandboxId, inputId, guest.input_offset(), 0);
    if (control.terminal === null)
      return yield* new StorageFailure({ cause: "PTY input head has no geometry" });
    const geometry = control.terminal;
    yield* Effect.try({
      try: () => guest.update_terminal(geometry.cols, geometry.rows, geometry.revision),
      catch: (cause) => new WasmFailure({ cause }),
    });
  }
  const kernel = initial.kernel;
  const checkpoint = yield* kernelCall(() => kernel.manifest());
  const state = {
    checkpointFuel: 0,
    capturedBytes: 0,
    resumeFuel: 0,
    session: initial,
    dirty: checkpoint !== initial.head.manifest,
    checkpoint,
  };
  if (restored !== null) {
    state.dirty = restored.dirty;
    state.checkpoint = restored.checkpointManifest;
    state.resumeFuel = restored.fuelUsed;
    state.checkpointFuel = restored.fuelUsed;
  }
  const captureStdio = Effect.fn("wasi.captureStdio")(function* (
    current: InstanceType<ReturnType<typeof createBindings>["WasmGuest"]>,
    partial: boolean,
  ) {
    if (capture === null || current.output_bytes() === state.capturedBytes) return false;
    const stdio = yield* Effect.try({
      try: () => ({ stdout: current.stdout_bytes(), stderr: current.stderr_bytes() }),
      catch: (cause) => new WasmFailure({ cause }),
    });
    yield* capture(stdio, partial);
    state.capturedBytes = stdio.stdout.byteLength + stdio.stderr.byteLength;
    return true;
  });
  const openFile = Effect.fn("wasi.openFile")(function* (
    input: typeof WasiOpen.Type,
    guest: InstanceType<ReturnType<typeof createBindings>["WasmGuest"]>,
  ) {
    if (input.read || !input.write) yield* requirePermission(capability, "read");
    if (input.write || input.create || input.truncate)
      yield* requirePermission(capability, "write");
    if (
      (input.truncate && !input.write) ||
      (input.exclusive && !input.create) ||
      (input.directory && input.create)
    )
      return yield* new Fault({
        code: "EINVAL",
        status: 400,
        message: "Invalid WASI open flags",
      });
    const found = yield* kernelCall(() => kernel.stat(input.path, input.follow)).pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(FileStat))),
      Effect.catchTag("Fault", (fault) => {
        if (fault.code === "ENOENT" && input.create) return Effect.succeed(null);
        return Effect.fail(fault);
      }),
    );
    if (found !== null && found.kind === "symlink")
      return yield* new Fault({
        code: "ELOOP",
        status: 400,
        message: "WASI open does not follow this symlink",
      });
    if (found !== null && input.create && input.exclusive)
      return yield* new Fault({
        code: "EEXIST",
        status: 409,
        message: "WASI exclusive file already exists",
      });
    if (found !== null && input.write && (found.mode & 0o200) === 0)
      return yield* new Fault({
        code: "EACCES",
        status: 403,
        message: "WASI file is not writable",
      });
    const parent = input.path.slice(0, input.path.lastIndexOf("/"));
    const path = yield* Effect.gen(function* () {
      if (found !== null) return found.path;
      const directory = yield* kernelCall(() => kernel.realpath(parent || "/"));
      if (directory === "/") return input.path.slice(input.path.lastIndexOf("/"));
      return directory + input.path.slice(input.path.lastIndexOf("/"));
    });
    if (input.base !== "/" && path !== input.base && !path.startsWith(input.base + "/"))
      return yield* new Fault({
        code: "ENOTCAPABLE",
        status: 403,
        message: "WASI symlink escapes its directory descriptor",
      });
    if (found !== null && input.directory && found.kind !== "directory")
      return yield* new Fault({
        code: "ENOTDIR",
        status: 400,
        message: "WASI directory open requires a directory",
      });
    if (found !== null && found.kind === "directory") {
      if (input.truncate || input.write)
        return yield* new Fault({
          code: "EISDIR",
          status: 400,
          message: "WASI cannot write a directory",
        });
      return { data: Buffer.alloc(0), path, directory: true, value: 0n };
    }
    const data = yield* Effect.gen(function* () {
      if (found === null || input.truncate) {
        yield* write(env, capability.sandboxId, kernel, path, Buffer.alloc(0));
        if (found === null) yield* kernelCall(() => kernel.chmod(path, input.mode));
        state.dirty = true;
        return Buffer.alloc(0);
      }
      if (guest.has_file(BigInt(found.inode))) return Buffer.alloc(0);
      if (found.size + guest.buffered_bytes() > 16_777_216)
        return yield* new Fault({
          code: "ENOMEM",
          status: 413,
          message: "WASI open buffers exceed 16 MiB",
        });
      return yield* read(env, capability.sandboxId, kernel, path, !input.read && input.write);
    });
    return { data, path, directory: false, value: 0n };
  });
  const changes = { pending: Deferred.makeUnsafe<void>() };
  const notify = Effect.fn("wasi.notify")(() =>
    Effect.gen(function* () {
      const previous = changes.pending;
      changes.pending = Deferred.makeUnsafe<void>();
      yield* Deferred.succeed(previous, undefined);
    }),
  );
  const semaphore = yield* Semaphore.make(1);
  const family = yield* Effect.acquireRelease(Scope.make(), (scope) =>
    Scope.close(scope, Exit.void),
  );
  const children = new Map<number, Fiber.Fiber<void>>();
  const failures: (WasmFailure | Fault | StorageFailure | Schema.SchemaError | CheckpointReady)[] =
    [];
  const handover = Effect.fn("wasi.handover")(function* (fuelUsed: number) {
    parking.active = true;
    const manifest = yield* kernelCall(() => kernel.manifest());
    const monotonic = (yield* Clock.monotonicTimeNanos) + clocks.offset;
    const savedAt = yield* Clock.currentTimeMillis;
    const handles = [];
    for (const [pid, active] of live) {
      transferred.add(active);
      const handle = yield* Effect.try({
        try: () => active.park(),
        catch: (cause) => new WasmFailure({ cause }),
      });
      handles.push({ pid, handle });
    }
    yield* Scope.close(family, Exit.void);
    const heap = yield* saveHeap(env.OBJECTS, capability.sandboxId, native.exports.memory, handles);
    const reference = yield* saveExecutionCheckpoint(env.OBJECTS, capability.sandboxId, {
      version: 1,
      heap,
      manifest,
      head: state.session.head,
      etag: state.session.etag,
      dirty: state.dirty,
      checkpointManifest: state.checkpoint,
      monotonic: monotonic.toString(),
      savedAt,
      fuelUsed,
    });
    return yield* new CheckpointReady({ reference });
  });
  if (inputId !== null) {
    const reader = Effect.gen(function* () {
      const pause = Effect.gen(function* () {
        if (stdinMode !== "pty") return () => Effect.sleep(1000);
        return yield* Schedule.toStepWithSleep(
          Schedule.exponential("16 millis").pipe(
            Schedule.modifyDelay(({ duration }) =>
              Effect.succeed(Duration.min(duration, Duration.seconds(1))),
            ),
            Schedule.map(() => undefined),
          ),
        );
      });
      const polling = { sleep: yield* pause };
      while (true) {
        if (parking.active) return;
        const wake = changes.pending;
        const hasReader = guest.stdin_has_reader();
        if (!hasReader && stdinMode !== "pty") {
          yield* finishInput(env, capability.sandboxId, inputId);
          return;
        }
        const capacity = guest.stdin_capacity();
        if (capacity > 0 || stdinMode === "pty") {
          const offset = guest.input_offset();
          const received = yield* readInput(env, capability.sandboxId, inputId, offset, capacity);
          const advanced = yield* semaphore.withPermits(1)(
            Effect.gen(function* () {
              const resized = yield* Effect.gen(function* () {
                if (stdinMode !== "pty") return false;
                if (received.terminal === null)
                  return yield* new StorageFailure({ cause: "PTY input head has no geometry" });
                const geometry = received.terminal;
                return yield* Effect.try({
                  try: () => guest.update_terminal(geometry.cols, geometry.rows, geometry.revision),
                  catch: (cause) => new WasmFailure({ cause }),
                });
              });
              const closed = guest.stdin_closed();
              if (hasReader && !closed && (received.data.length > 0 || received.closed)) {
                yield* Effect.try({
                  try: () =>
                    guest.feed_stdin(
                      received.data,
                      received.closed && offset + received.data.length === received.total,
                    ),
                  catch: (cause) => new WasmFailure({ cause }),
                });
                if (stdinMode === "pty") yield* captureStdio(guest, false);
              }
              return resized || guest.input_offset() > offset || (!closed && guest.stdin_closed());
            }),
          );
          if (!hasReader && !received.closed)
            yield* finishInput(env, capability.sandboxId, inputId);
          if (advanced) {
            yield* notify();
            polling.sleep = yield* pause;
          }
          if (
            received.closed &&
            guest.input_offset() === received.total &&
            guest.stdin_closed() &&
            stdinMode !== "pty"
          )
            return;
          if (advanced) continue;
        }
        yield* Effect.raceFirst(polling.sleep(undefined).pipe(Effect.orDie), Deferred.await(wake));
      }
    }).pipe(
      Effect.catch((cause) =>
        Effect.gen(function* () {
          failures.push(cause);
          yield* notify();
        }),
      ),
    );
    yield* Scope.provide(family)(Effect.forkScoped(reader));
  }

  const runGuest: (
    guest: InstanceType<ReturnType<typeof createBindings>["WasmGuest"]>,
  ) => Effect.Effect<
    typeof RunResult.Type,
    WasmFailure | Fault | StorageFailure | Schema.SchemaError | CheckpointReady
  > = Effect.fn("wasi.runGuest")(function* (guest) {
    const completed: (typeof RunResult.Type)[] = [];
    while (completed.length === 0) {
      yield* Effect.scoped(
        Effect.gen(function* () {
          const lease = yield* Effect.acquireRelease(
            semaphore.take(1).pipe(Effect.as({ held: true })),
            (lease) =>
              Effect.gen(function* () {
                yield* notify();
                if (lease.held) yield* semaphore.release(1);
              }),
          );
          const failed = failures[0];
          if (failed !== undefined) return yield* Effect.fail(failed);

          const now = yield* Clock.currentTimeMillis;
          if (capability.expiresAt <= now)
            return yield* new Fault({
              code: "UNAUTHORIZED",
              status: 401,
              message: "Capability expired",
            });
          const raw = yield* Effect.try({
            try: () => guest.step(),
            catch: (cause) => new WasmFailure({ cause }),
          });
          const step = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(WasmStep), {
            onExcessProperty: "error",
          })(raw);
          const readinessChanged = yield* Effect.try({
            try: () => guest.take_readiness_notification(),
            catch: (cause) => new WasmFailure({ cause }),
          });
          if (readinessChanged) yield* notify();
          if (
            step.kind !== "yield" ||
            state.checkpointFuel === 0 ||
            step.fuelUsed - state.checkpointFuel >= 10_000_000
          ) {
            const captured = yield* captureStdio(guest, step.kind === "yield");
            if (captured && step.kind === "yield") state.checkpointFuel = step.fuelUsed;
          }
          const authorizedAt = yield* Clock.currentTimeMillis;
          if (capability.expiresAt <= authorizedAt)
            return yield* new Fault({
              code: "UNAUTHORIZED",
              status: 401,
              message: "Capability expired",
            });
          if (step.kind === "yield") {
            if (canHandover && guest.pid === 1 && step.fuelUsed - state.resumeFuel >= 50_000_000)
              return yield* handover(step.fuelUsed);
            yield* Effect.yieldNow;
            return;
          }
          if (step.kind === "stopped") {
            lease.held = false;
            yield* semaphore.release(1);
            while (true) {
              if (
                canHandover &&
                guest.pid === 1 &&
                (yield* Clock.currentTimeMillis) >= handoverAt
              ) {
                yield* semaphore.take(1);
                lease.held = true;
                return yield* handover(Number(guest.fuel_used()));
              }
              const wake = changes.pending;
              const stopped = yield* Effect.try({
                try: () => guest.is_stopped(),
                catch: (cause) => new WasmFailure({ cause }),
              });
              if (!stopped) break;
              const now = yield* Clock.currentTimeMillis;
              const untilExpiry = capability.expiresAt - now;
              if (untilExpiry <= 0)
                return yield* new Fault({
                  code: "UNAUTHORIZED",
                  status: 401,
                  message: "Capability expired while stopped",
                });
              const pause = Match.value(canHandover && guest.pid === 1).pipe(
                Match.when(true, () => Math.min(1000, untilExpiry, Math.max(0, handoverAt - now))),
                Match.orElse(() => untilExpiry),
              );
              yield* Effect.raceFirst(Deferred.await(wake), Effect.sleep(pause));
            }
            return;
          }
          const timestamp = yield* Clock.currentTimeNanos;
          yield* kernelCall(() => kernel.set_time(timestamp));
          if (step.kind === "done") {
            if (state.dirty) {
              yield* publish(env, capability.sandboxId, state.session);
              state.checkpoint = state.session.head.manifest;
              state.dirty = false;
            }
            completed.push(step.output);
            return;
          }
          if (step.kind === "wait" || (step.kind === "poll" && !step.immediate)) {
            lease.held = false;
            yield* semaphore.release(1);
          }
          const response = yield* Match.value(step)
            .pipe(
              Match.when({ kind: "exec" }, (input) =>
                Effect.gen(function* () {
                  yield* requirePermission(capability, "execute");
                  yield* requirePermission(capability, "read");
                  const image = yield* Effect.gen(function* () {
                    if (input.fd !== null) {
                      const fd = input.fd;
                      const bytes = yield* Effect.try({
                        try: () => guest.file_data(fd),
                        catch: (cause) => new WasmFailure({ cause }),
                      });
                      return yield* loadExecutable(
                        env,
                        capability,
                        kernel,
                        `/dev/fd/${fd}`,
                        input.argv,
                        input.cwd,
                        Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength),
                      );
                    }
                    if (input.path === null)
                      return yield* new Fault({
                        code: "EINVAL",
                        status: 400,
                        message: "Missing exec image",
                      });
                    const image = input.path;
                    const path = Match.value(image.startsWith("/")).pipe(
                      Match.when(true, () => image),
                      Match.orElse(() => `${input.cwd}/${image}`),
                    );
                    return yield* loadExecutable(
                      env,
                      capability,
                      kernel,
                      path,
                      input.argv,
                      input.cwd,
                    );
                  });
                  yield* Effect.try({
                    try: () =>
                      guest.replace_image(
                        image.bytes,
                        Schema.encodeSync(
                          Schema.fromJsonString(
                            WasmConfiguration.mapFields((fields) => Struct.omit(fields, ["stdin"])),
                          ),
                        )({ argv: image.argv, env: { ...input.env, PWD: input.cwd } }),
                      ),
                    catch: (cause) => new WasmFailure({ cause }),
                  });
                  return { data: Buffer.alloc(0), path: "/", directory: false, value: 0n };
                }),
              ),
              Match.when({ kind: "spawn" }, (input) =>
                Effect.gen(function* () {
                  yield* requirePermission(capability, "execute");
                  yield* requirePermission(capability, "read");
                  const location = { cwd: "/" };
                  for (const next of input.cwdSteps) {
                    const joined = Match.value(next.startsWith("/")).pipe(
                      Match.when(true, () => next),
                      Match.orElse(() => `${location.cwd}/${next}`),
                    );
                    const cwd = yield* kernelCall(() => kernel.realpath(joined));
                    const directory = yield* kernelCall(() => kernel.stat(cwd, true)).pipe(
                      Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(FileStat))),
                    );
                    if (directory.kind !== "directory")
                      return yield* new Fault({
                        code: "ENOTDIR",
                        status: 400,
                        message: "Child cwd is not a directory",
                      });
                    if ((directory.mode & 0o100) === 0)
                      return yield* new Fault({
                        code: "EACCES",
                        status: 403,
                        message: "Child cwd is not searchable",
                      });
                    location.cwd = directory.path;
                  }
                  for (const [index, action] of input.actions.entries()) {
                    if (action.command === 4) {
                      const joined = Match.value(action.path.startsWith("/")).pipe(
                        Match.when(true, () => action.path),
                        Match.orElse(() => `${location.cwd}/${action.path}`),
                      );
                      const cwd = yield* kernelCall(() => kernel.realpath(joined));
                      const directory = yield* kernelCall(() => kernel.stat(cwd, true)).pipe(
                        Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(FileStat))),
                      );
                      if (directory.kind !== "directory")
                        return yield* new Fault({
                          code: "ENOTDIR",
                          status: 400,
                          message: "Child cwd is not a directory",
                        });
                      if ((directory.mode & 0o100) === 0)
                        return yield* new Fault({
                          code: "EACCES",
                          status: 403,
                          message: "Child cwd is not searchable",
                        });
                      location.cwd = directory.path;
                      continue;
                    }
                    const staged = yield* Effect.gen(function* () {
                      if (action.command === 3) {
                        const path = Match.value(action.path.startsWith("/")).pipe(
                          Match.when(true, () => action.path),
                          Match.orElse(() => `${location.cwd}/${action.path}`),
                        );
                        const opened = yield* openFile(
                          {
                            kind: "open",
                            path,
                            base: "/",
                            read: (action.flags & 3) !== 1,
                            write: (action.flags & 3) !== 0,
                            create: (action.flags & 0x40) !== 0,
                            exclusive: (action.flags & 0x80) !== 0,
                            truncate: (action.flags & 0x200) !== 0,
                            directory: (action.flags & 0x10000) !== 0,
                            follow: (action.flags & 0x20000) === 0,
                            mode: action.mode,
                          },
                          guest,
                        );
                        const stat = yield* kernelCall(() => kernel.stat(opened.path, true)).pipe(
                          Effect.flatMap(
                            Schema.decodeUnknownEffect(Schema.fromJsonString(FileStat)),
                          ),
                        );
                        return yield* Effect.try({
                          try: () =>
                            guest.spawn_open(
                              index,
                              opened.data,
                              opened.path,
                              opened.directory,
                              statBytes(stat),
                            ),
                          catch: (cause) => new WasmFailure({ cause }),
                        });
                      }
                      return yield* Effect.try({
                        try: () => guest.spawn_action(index),
                        catch: (cause) => new WasmFailure({ cause }),
                      });
                    }).pipe(
                      Effect.flatMap(
                        Schema.decodeUnknownEffect(Schema.fromJsonString(SpawnStageResult)),
                      ),
                    );
                    if (staged.errno !== 0) {
                      const code = Match.value(staged.errno).pipe(
                        Match.when(8, () => "EBADF"),
                        Match.when(33, () => "EMFILE"),
                        Match.when(44, () => "ENOENT"),
                        Match.when(48, () => "ENOMEM"),
                        Match.when(54, () => "ENOTDIR"),
                        Match.orElse(() => "EINVAL"),
                      );
                      return yield* new Fault({
                        code,
                        status: 400,
                        message: "Child file action failed",
                      });
                    }
                    if (action.command === 5 && staged.path !== null) {
                      const path = staged.path;
                      const directory = yield* kernelCall(() => kernel.stat(path, true)).pipe(
                        Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(FileStat))),
                      );
                      if ((directory.mode & 0o100) === 0)
                        return yield* new Fault({
                          code: "EACCES",
                          status: 403,
                          message: "Child cwd is not searchable",
                        });
                      location.cwd = directory.path;
                    }
                  }
                  const stat = yield* Effect.gen(function* () {
                    const paths: string[] = [];
                    if (input.searchPath === null || input.path.includes("/")) {
                      if (input.path.startsWith("/")) paths.push(input.path);
                      else paths.push(`${location.cwd}/${input.path}`);
                    } else {
                      for (const directory of input.searchPath.split(":")) {
                        if (directory.startsWith("/")) paths.push(`${directory}/${input.path}`);
                        else paths.push(`${location.cwd}/${directory}/${input.path}`);
                      }
                    }
                    const access = { denied: false };
                    for (const path of paths) {
                      const found = yield* kernelCall(() => kernel.stat(path, true)).pipe(
                        Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(FileStat))),
                        Effect.catchTag("Fault", (fault) => {
                          if (fault.code === "ENOENT" || fault.code === "ENOTDIR")
                            return Effect.succeed(null);
                          if (fault.code === "EACCES") {
                            access.denied = true;
                            return Effect.succeed(null);
                          }
                          return Effect.fail(fault);
                        }),
                      );
                      if (found === null) continue;
                      if (found.kind === "file" && (found.mode & 0o111) !== 0) return found;
                      access.denied = true;
                    }
                    if (access.denied)
                      return yield* new Fault({
                        code: "EACCES",
                        status: 403,
                        message: "Child image is not executable",
                      });
                    return yield* new Fault({
                      code: "ENOENT",
                      status: 404,
                      message: "Child image was not found",
                    });
                  });
                  const image = yield* loadExecutable(
                    env,
                    capability,
                    kernel,
                    stat.path,
                    input.argv,
                    location.cwd,
                  );
                  const childScope = yield* Scope.provide(family)(
                    Effect.acquireRelease(Scope.make(), (scope) => Scope.close(scope, Exit.void)),
                  );
                  const child = yield* Scope.provide(childScope)(
                    Effect.acquireRelease(
                      Effect.try({
                        try: () =>
                          guest.spawn_child(
                            image.bytes,
                            Schema.encodeSync(
                              Schema.fromJsonString(
                                WasmConfiguration.mapFields((fields) =>
                                  Struct.omit(fields, ["stdin"]),
                                ),
                              ),
                            )({ argv: image.argv, env: { ...input.env, PWD: location.cwd } }),
                            location.cwd,
                          ),
                        catch: (cause) => new WasmFailure({ cause }),
                      }),
                      (child) =>
                        Effect.sync(() => {
                          if (child !== undefined && !transferred.has(child)) {
                            live.delete(child.pid);
                            child.free();
                          }
                        }),
                    ),
                  );
                  if (child !== undefined) {
                    yield* startChild(childScope, child);
                  } else yield* Scope.close(childScope, Exit.void);
                  return { data: Buffer.alloc(0), path: "/", directory: false, value: 0n };
                }),
              ),
              Match.when({ kind: "wait" }, (input) =>
                Effect.gen(function* () {
                  while (true) {
                    if (
                      canHandover &&
                      guest.pid === 1 &&
                      (yield* Clock.currentTimeMillis) >= handoverAt
                    ) {
                      yield* semaphore.take(1);
                      lease.held = true;
                      return yield* handover(Number(guest.fuel_used()));
                    }
                    const wake = changes.pending;
                    const interrupted = yield* Effect.try({
                      try: () => guest.signal_ready(),
                      catch: (cause) => new WasmFailure({ cause }),
                    });
                    const ready = yield* Effect.try({
                      try: () => guest.wait_ready(),
                      catch: (cause) => new WasmFailure({ cause }),
                    });
                    if (interrupted || ready) break;
                    const waiting = input.pids.flatMap((pid) => {
                      const fiber = children.get(pid);
                      if (fiber === undefined) return [];
                      return [Fiber.await(fiber).pipe(Effect.asVoid)];
                    });
                    if (waiting.length === 0) break;
                    if (canHandover && guest.pid === 1) {
                      const remaining = Math.max(0, handoverAt - (yield* Clock.currentTimeMillis));
                      waiting.push(Effect.sleep(Math.min(1000, remaining)));
                    }
                    yield* Effect.raceAllFirst([...waiting, Deferred.await(wake)]);
                  }
                  return { data: Buffer.alloc(0), path: "/", directory: false, value: 0n };
                }),
              ),
            )
            .pipe(
              Match.when({ kind: "open" }, (input) => openFile(input, guest)),
              Match.when({ kind: "tmpfile" }, (input) =>
                Effect.gen(function* () {
                  yield* requirePermission(capability, "write");
                  if (input.read) yield* requirePermission(capability, "read");
                  const directory = yield* kernelCall(() => kernel.realpath(input.path));
                  if (
                    input.base !== "/" &&
                    directory !== input.base &&
                    !directory.startsWith(input.base + "/")
                  )
                    return yield* new Fault({
                      code: "ENOTCAPABLE",
                      status: 403,
                      message: "Temporary file escapes its directory descriptor",
                    });
                  const stat = yield* kernelCall(() =>
                    kernel.temporary_file(directory, input.mode),
                  ).pipe(
                    Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(FileStat))),
                  );
                  state.dirty = true;
                  const data = statBytes(stat);
                  return { data, path: directory, directory: false, value: 0n };
                }),
              ),
              Match.when({ kind: "flush" }, (input) =>
                Effect.gen(function* () {
                  yield* requirePermission(capability, "write");
                  const data = yield* Effect.try({
                    try: () => guest.file_data(input.fd),
                    catch: (cause) => new WasmFailure({ cause }),
                  });
                  if (input.path === null) {
                    const metadata = Buffer.from(guest.file_metadata(input.fd));
                    metadata.writeBigUInt64LE(BigInt(data.byteLength), 32);
                    metadata.writeBigUInt64LE(timestamp, 48);
                    metadata.writeBigUInt64LE(timestamp, 56);
                    return { data: metadata, path: "/", directory: false, value: 0n };
                  }
                  yield* write(
                    env,
                    capability.sandboxId,
                    kernel,
                    Buffer.from(guest.file_metadata(input.fd)).readBigUInt64LE(8),
                    Buffer.from(data),
                  );
                  state.dirty = true;
                  return { data: Buffer.alloc(0), path: "/", directory: false, value: 0n };
                }),
              ),
              Match.when({ kind: "fdTimes" }, (input) =>
                Effect.gen(function* () {
                  yield* requirePermission(capability, "write");
                  if (input.path === null) {
                    const metadata = Buffer.from(guest.file_metadata(input.fd));
                    if ((input.flags & 1) !== 0) metadata.writeBigUInt64LE(BigInt(input.atime), 40);
                    if ((input.flags & 2) !== 0) metadata.writeBigUInt64LE(timestamp, 40);
                    if ((input.flags & 4) !== 0) metadata.writeBigUInt64LE(BigInt(input.mtime), 48);
                    if ((input.flags & 8) !== 0) metadata.writeBigUInt64LE(timestamp, 48);
                    if (input.flags !== 0) metadata.writeBigUInt64LE(timestamp, 56);
                    return { data: metadata, path: "/", directory: false, value: 0n };
                  }
                  const inode = Buffer.from(guest.file_metadata(input.fd)).readBigUInt64LE(8);
                  yield* kernelCall(() =>
                    kernel.set_inode_times(
                      inode,
                      BigInt(input.atime),
                      BigInt(input.mtime),
                      input.flags,
                    ),
                  );
                  if (input.flags !== 0) state.dirty = true;
                  const stat = yield* kernelCall(() => kernel.stat_inode(inode)).pipe(
                    Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(FileStat))),
                  );
                  return {
                    data: statBytes(stat),
                    path: stat.path,
                    directory: stat.kind === "directory",
                    value: 0n,
                  };
                }),
              ),
              Match.when({ kind: "pathTimes" }, (input) =>
                Effect.gen(function* () {
                  yield* requirePermission(capability, "write");
                  const path = yield* resolvePath(kernel, input.path, input.base);
                  const stat = yield* kernelCall(() => kernel.stat(path, input.follow)).pipe(
                    Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(FileStat))),
                  );
                  if (
                    input.base !== "/" &&
                    stat.path !== input.base &&
                    !stat.path.startsWith(input.base + "/")
                  )
                    return yield* new Fault({
                      code: "ENOTCAPABLE",
                      status: 403,
                      message: "WASI timestamps follow a symlink outside its directory descriptor",
                    });
                  yield* kernelCall(() =>
                    kernel.set_times(
                      stat.path,
                      input.follow,
                      BigInt(input.atime),
                      BigInt(input.mtime),
                      input.flags,
                    ),
                  );
                  if (input.flags !== 0) state.dirty = true;
                  const updated = yield* kernelCall(() =>
                    kernel.stat(stat.path, input.follow),
                  ).pipe(
                    Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(FileStat))),
                  );
                  return {
                    data: statBytes(updated),
                    path: updated.path,
                    directory: updated.kind === "directory",
                    value: 0n,
                  };
                }),
              ),
              Match.when({ kind: "fdStat" }, (input) =>
                Effect.gen(function* () {
                  if (input.write) yield* requirePermission(capability, "write");
                  else yield* requirePermission(capability, "read");
                  const metadata = Buffer.from(guest.file_metadata(input.fd));
                  if (input.path === null)
                    return {
                      data: metadata,
                      path: "/",
                      directory: false,
                      value: 0n,
                    };
                  const path = input.path;
                  const stat = yield* kernelCall(() => {
                    if (metadata[16] === 4) return kernel.stat_inode(metadata.readBigUInt64LE(8));
                    return kernel.stat(path, true);
                  }).pipe(
                    Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(FileStat))),
                  );
                  return {
                    data: statBytes(stat),
                    path: stat.path,
                    directory: stat.kind === "directory",
                    value: 0n,
                  };
                }),
              ),
              Match.when({ kind: "pathStat" }, (input) =>
                Effect.gen(function* () {
                  yield* requirePermission(capability, "read");
                  const path = yield* resolvePath(kernel, input.path, input.base);
                  const stat = yield* kernelCall(() => kernel.stat(path, input.follow)).pipe(
                    Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(FileStat))),
                  );
                  if (
                    input.base !== "/" &&
                    stat.path !== input.base &&
                    !stat.path.startsWith(input.base + "/")
                  )
                    return yield* new Fault({
                      code: "ENOTCAPABLE",
                      status: 403,
                      message: "WASI stat follows a symlink outside its directory descriptor",
                    });
                  return {
                    data: statBytes(stat),
                    path: stat.path,
                    directory: stat.kind === "directory",
                    value: 0n,
                  };
                }),
              ),
              Match.when({ kind: "directory" }, (input) =>
                Effect.gen(function* () {
                  yield* requirePermission(capability, "read");
                  const json = yield* kernelCall(() => kernel.readdir(input.path));
                  const entries = yield* Schema.decodeUnknownEffect(
                    Schema.fromJsonString(DirectoryEntries),
                  )(json);
                  return {
                    data: Buffer.from(
                      Schema.encodeSync(Schema.fromJsonString(DirectoryEntries))(entries),
                    ),
                    path: input.path,
                    directory: true,
                    value: 0n,
                  };
                }),
              ),
              Match.when({ kind: "mkdir" }, (input) =>
                Effect.gen(function* () {
                  yield* requirePermission(capability, "write");
                  const path = yield* resolvePath(kernel, input.path, input.base);
                  const existing = yield* kernelCall(() => kernel.stat(path, false)).pipe(
                    Effect.result,
                  );
                  if (existing._tag === "Success")
                    return yield* new Fault({
                      code: "EEXIST",
                      status: 409,
                      message: "WASI directory already exists",
                    });
                  if (existing.failure._tag !== "Fault" || existing.failure.code !== "ENOENT")
                    return yield* existing.failure;
                  yield* kernelCall(() => kernel.mkdir(path, false));
                  yield* kernelCall(() => kernel.chmod(path, input.mode));
                  state.dirty = true;
                  return { data: Buffer.alloc(0), path, directory: true, value: 0n };
                }),
              ),
              Match.when({ kind: "remove" }, (input) =>
                Effect.gen(function* () {
                  yield* requirePermission(capability, "write");
                  const path = yield* resolvePath(kernel, input.path, input.base);
                  const stat = yield* kernelCall(() => kernel.stat(path, false)).pipe(
                    Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(FileStat))),
                  );
                  if (input.directory && stat.kind !== "directory")
                    return yield* new Fault({
                      code: "ENOTDIR",
                      status: 400,
                      message: "WASI remove_directory requires a directory",
                    });
                  if (!input.directory && stat.kind === "directory")
                    return yield* new Fault({
                      code: "EISDIR",
                      status: 400,
                      message: "WASI unlink_file cannot remove a directory",
                    });
                  yield* kernelCall(() => kernel.remove(path, false));
                  const remaining = yield* kernelCall(() => kernel.inode_path(BigInt(stat.inode)));
                  const retained = yield* Effect.gen(function* () {
                    if (remaining !== undefined)
                      return yield* kernelCall(() => kernel.stat_inode(BigInt(stat.inode))).pipe(
                        Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(FileStat))),
                      );
                    return { ...stat, nlink: 0, ctimeNs: timestamp.toString() };
                  });
                  yield* Effect.try({
                    try: () => guest.refresh_file(statBytes(retained), remaining),
                    catch: (cause) => new WasmFailure({ cause }),
                  });
                  state.dirty = true;
                  return { data: Buffer.alloc(0), path, directory: input.directory, value: 0n };
                }),
              ),
              Match.when({ kind: "link" }, (input) =>
                Effect.gen(function* () {
                  yield* requirePermission(capability, "write");
                  const from = yield* resolvePath(kernel, input.from, input.fromBase, input.follow);
                  const to = yield* resolvePath(kernel, input.to, input.toBase);
                  yield* kernelCall(() => kernel.link(from, to, input.follow));
                  const stat = yield* kernelCall(() => kernel.stat(to, false)).pipe(
                    Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(FileStat))),
                  );
                  const remaining = yield* kernelCall(() => kernel.inode_path(BigInt(stat.inode)));
                  yield* Effect.try({
                    try: () => guest.refresh_file(statBytes(stat), remaining),
                    catch: (cause) => new WasmFailure({ cause }),
                  });
                  state.dirty = true;
                  return { data: Buffer.alloc(0), path: to, directory: false, value: 0n };
                }),
              ),
              Match.when({ kind: "rename" }, (input) =>
                Effect.gen(function* () {
                  yield* requirePermission(capability, "write");
                  const from = yield* resolvePath(kernel, input.from, input.fromBase);
                  const to = yield* resolvePath(kernel, input.to, input.toBase);
                  const source = yield* kernelCall(() => kernel.stat(from, false)).pipe(
                    Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(FileStat))),
                  );
                  const target = yield* kernelCall(() => kernel.stat(to, false)).pipe(
                    Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(FileStat))),
                    Effect.catchTag("Fault", (fault) => {
                      if (fault.code === "ENOENT") return Effect.succeed(null);
                      return Effect.fail(fault);
                    }),
                  );
                  yield* kernelCall(() => kernel.rename(from, to));
                  if (target?.inode === source.inode)
                    return { data: Buffer.from(to), path: from, directory: false, value: 1n };
                  if (target !== null) {
                    const remaining = yield* kernelCall(() =>
                      kernel.inode_path(BigInt(target.inode)),
                    );
                    const retained = yield* Effect.gen(function* () {
                      if (remaining !== undefined)
                        return yield* kernelCall(() =>
                          kernel.stat_inode(BigInt(target.inode)),
                        ).pipe(
                          Effect.flatMap(
                            Schema.decodeUnknownEffect(Schema.fromJsonString(FileStat)),
                          ),
                        );
                      return { ...target, nlink: 0, ctimeNs: timestamp.toString() };
                    });
                    yield* Effect.try({
                      try: () => guest.refresh_file(statBytes(retained), remaining),
                      catch: (cause) => new WasmFailure({ cause }),
                    });
                  }
                  state.dirty = true;
                  return { data: Buffer.from(to), path: from, directory: false, value: 0n };
                }),
              ),
              Match.when({ kind: "symlink" }, (input) =>
                Effect.gen(function* () {
                  yield* requirePermission(capability, "write");
                  const path = yield* resolvePath(kernel, input.path, input.base);
                  yield* kernelCall(() => kernel.symlink(input.target, path));
                  state.dirty = true;
                  return { data: Buffer.alloc(0), path, directory: false, value: 0n };
                }),
              ),
              Match.when({ kind: "readlink" }, (input) =>
                Effect.gen(function* () {
                  yield* requirePermission(capability, "read");
                  const path = yield* resolvePath(kernel, input.path, input.base);
                  const target = yield* kernelCall(() => kernel.readlink(path));
                  return { data: Buffer.from(target), path, directory: false, value: 0n };
                }),
              ),
              Match.when({ kind: "poll" }, (input) =>
                Effect.gen(function* () {
                  const realtime = yield* Clock.currentTimeNanos;
                  const monotonic = (yield* Clock.monotonicTimeNanos) + clocks.offset;
                  const deadlines = input.clocks.map((clock) => {
                    const now = Match.value(clock.clock).pipe(
                      Match.when(0, () => realtime),
                      Match.orElse(() => monotonic),
                    );
                    const deadline = Match.value(clock.absolute).pipe(
                      Match.when(true, () => BigInt(clock.timeout)),
                      Match.orElse(() => now + BigInt(clock.timeout)),
                    );
                    return {
                      index: clock.index,
                      clock: clock.clock,
                      deadline,
                      precision: BigInt(clock.precision),
                      remaining: deadline - now,
                    };
                  });
                  for (const clock of deadlines) {
                    yield* Effect.try({
                      try: () => guest.set_poll_deadline(clock.index, clock.deadline.toString()),
                      catch: (cause) => new WasmFailure({ cause }),
                    });
                  }
                  const readings = { realtime, monotonic };
                  while (!input.immediate) {
                    const failed = failures[0];
                    if (failed !== undefined) return yield* Effect.fail(failed);
                    const wake = changes.pending;
                    yield* semaphore.take(1);
                    lease.held = true;
                    if (
                      canHandover &&
                      guest.pid === 1 &&
                      (yield* Clock.currentTimeMillis) >= handoverAt
                    )
                      return yield* handover(Number(guest.fuel_used()));
                    const ioReady = yield* Effect.try({
                      try: () => guest.io_ready(),
                      catch: (cause) => new WasmFailure({ cause }),
                    });
                    if (
                      ioReady ||
                      deadlines.some((clock) => {
                        const actual = Match.value(clock.clock).pipe(
                          Match.when(0, () => readings.realtime),
                          Match.orElse(() => readings.monotonic),
                        );
                        return clock.deadline <= actual;
                      })
                    )
                      break;
                    const untilExpiry =
                      BigInt(capability.expiresAt) * 1_000_000n - readings.realtime;
                    if (untilExpiry <= 0n)
                      return yield* new Fault({
                        code: "UNAUTHORIZED",
                        status: 401,
                        message: "Capability expired while waiting",
                      });
                    const first = deadlines.reduce((minimum, clock) => {
                      const actual = Match.value(clock.clock).pipe(
                        Match.when(0, () => readings.realtime),
                        Match.orElse(() => readings.monotonic),
                      );
                      const remaining = clock.deadline - actual;
                      if (remaining < minimum) return remaining;
                      return minimum;
                    }, untilExpiry);
                    lease.held = false;
                    yield* semaphore.release(1);
                    const pause = yield* Effect.gen(function* () {
                      const desired = Duration.max(Duration.nanos(first), Duration.millis(1));
                      if (!canHandover || guest.pid !== 1) return desired;
                      const remaining = Math.max(0, handoverAt - (yield* Clock.currentTimeMillis));
                      return Duration.min(desired, Duration.millis(Math.min(1000, remaining)));
                    });
                    yield* Effect.raceFirst(Effect.sleep(pause), Deferred.await(wake));
                    readings.realtime = yield* Clock.currentTimeNanos;
                    readings.monotonic = (yield* Clock.monotonicTimeNanos) + clocks.offset;
                  }
                  const now = yield* Clock.currentTimeMillis;
                  if (capability.expiresAt <= now)
                    return yield* new Fault({
                      code: "UNAUTHORIZED",
                      status: 401,
                      message: "Capability expired while waiting",
                    });
                  const actualRealtime = readings.realtime;
                  const actualMonotonic = readings.monotonic;
                  const ready = deadlines
                    .filter((clock) => {
                      const actual = Match.value(clock.clock).pipe(
                        Match.when(0, () => actualRealtime),
                        Match.orElse(() => actualMonotonic),
                      );
                      return clock.deadline <= actual;
                    })
                    .map((clock) => clock.index);
                  return {
                    data: Buffer.from(
                      Schema.encodeSync(Schema.fromJsonString(Schema.Array(Schema.Int)))(ready),
                    ),
                    path: "/",
                    directory: false,
                    value: 0n,
                  };
                }),
              ),
              Match.when({ kind: "sync" }, () =>
                Effect.gen(function* () {
                  if (state.dirty) {
                    yield* publish(env, capability.sandboxId, state.session);
                    state.checkpoint = state.session.head.manifest;
                    state.dirty = false;
                  }
                  return { data: Buffer.alloc(0), path: "/", directory: false, value: 0n };
                }),
              ),
              Match.when({ kind: "random" }, (input) =>
                Effect.sync(() => ({
                  data: Buffer.from(crypto.getRandomValues(new Uint8Array(input.length))),
                  path: "/",
                  directory: false,
                  value: 0n,
                })),
              ),
              Match.when({ kind: "clock" }, (input) =>
                Effect.gen(function* () {
                  if (input.clock === 0) {
                    const now = yield* Clock.currentTimeMillis;
                    return {
                      data: Buffer.alloc(0),
                      path: "/",
                      directory: false,
                      value: BigInt(now) * 1_000_000n,
                    };
                  }
                  const nanos = (yield* Clock.monotonicTimeNanos) + clocks.offset;
                  return { data: Buffer.alloc(0), path: "/", directory: false, value: nanos };
                }),
              ),
              Match.exhaustive,
              Effect.result,
            );
          if (response._tag === "Success") {
            if (step.kind === "exec") return;
            if (step.kind === "spawn") return;
            const value = response.success;
            const metadata = yield* Effect.gen(function* () {
              if (step.kind === "tmpfile") return value.data;
              if (step.kind === "open") {
                const stat = yield* kernelCall(() => kernel.stat(value.path, true)).pipe(
                  Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(FileStat))),
                );
                return statBytes(stat);
              }
              if (step.kind === "flush") {
                if (step.path === null) return value.data;
                const inode = Buffer.from(guest.file_metadata(step.fd)).readBigUInt64LE(8);
                const stat = yield* kernelCall(() => kernel.stat_inode(inode)).pipe(
                  Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(FileStat))),
                );
                return statBytes(stat);
              }
              return Buffer.alloc(0);
            });
            yield* Effect.try({
              try: () =>
                guest.respond(0, value.data, value.path, value.directory, value.value, metadata),
              catch: (cause) => new WasmFailure({ cause }),
            });
            if (step.kind === "rename" && value.value === 0n) {
              const renamed = yield* kernelCall(() =>
                kernel.stat(Buffer.from(value.data).toString("utf8"), false),
              ).pipe(Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(FileStat))));
              if (renamed.kind !== "directory") {
                const remaining = yield* kernelCall(() => kernel.inode_path(BigInt(renamed.inode)));
                yield* Effect.try({
                  try: () => guest.refresh_file(statBytes(renamed), remaining),
                  catch: (cause) => new WasmFailure({ cause }),
                });
              }
            }
          } else {
            if (response.failure._tag !== "Fault") return yield* response.failure;
            if (response.failure.code === "CONFLICT") return yield* response.failure;
            const errno =
              new Map([
                ["FORBIDDEN", 2],
                ["EACCES", 2],
                ["EBADF", 8],
                ["EMFILE", 33],
                ["EPERM", 63],
                ["EROFS", 69],
                ["ENOENT", 44],
                ["EEXIST", 20],
                ["EISDIR", 31],
                ["ENOTDIR", 54],
                ["ENOTEMPTY", 55],
                ["ENOSPC", 51],
                ["ENOMEM", 48],
                ["EFBIG", 22],
                ["E2BIG", 1],
                ["ENOEXEC", 45],
                ["UNSUPPORTED_RUNTIME", 45],
                ["EILSEQ", 25],
                ["ELOOP", 32],
                ["ENOTCAPABLE", 76],
                ["EIO", 29],
              ]).get(response.failure.code) ?? 28;
            yield* Effect.try({
              try: () => guest.respond(errno, Buffer.alloc(0), "/", false, 0n, Buffer.alloc(0)),
              catch: (cause) => new WasmFailure({ cause }),
            });
          }
        }),
      );
      if (children.size > 0) yield* Effect.yieldNow;
    }
    return completed[0];
  });
  const startChild = Effect.fn("wasi.startChild")(function* (
    scope: Effect.Success<ReturnType<typeof Scope.make>>,
    child: InstanceType<ReturnType<typeof createBindings>["WasmGuest"]>,
  ) {
    const pid = child.pid;
    live.set(pid, child);
    const work = Effect.gen(function* () {
      const outcome = yield* runGuest(child).pipe(Effect.result);
      if (transferred.has(child)) return;
      yield* Effect.sync(() => child.finish_child(outcome._tag === "Failure"));
      if (outcome._tag === "Failure") failures.push(outcome.failure);
    }).pipe(
      Effect.ensuring(Scope.close(scope, Exit.void)),
      Effect.ensuring(
        Effect.gen(function* () {
          children.delete(pid);
          yield* notify();
        }),
      ),
    );
    const fiber = yield* Scope.provide(family)(Effect.forkScoped(work));
    children.set(pid, fiber);
  });
  for (const item of native.handles.filter((item) => item.pid !== 1)) {
    const scope = yield* Scope.provide(family)(
      Effect.acquireRelease(Scope.make(), (scope) => Scope.close(scope, Exit.void)),
    );
    const child = yield* Scope.provide(scope)(
      Effect.acquireRelease(
        Effect.try({
          try: () => native.bindings.WasmGuest.resume(item.handle),
          catch: (cause) => new WasmFailure({ cause }),
        }),
        (child) =>
          Effect.sync(() => {
            if (!transferred.has(child)) {
              live.delete(item.pid);
              child.free();
            }
          }),
      ),
    );
    yield* startChild(scope, child);
  }
  return yield* Effect.gen(function* () {
    yield* runGuest(guest);
    while (children.size > 0) yield* Fiber.awaitAll(Array.from(children.values()));
    const failure = failures[0];
    if (failure !== undefined) return yield* Effect.fail(failure);
    const terminal = yield* Effect.try({
      try: () => guest.step(),
      catch: (cause) => new WasmFailure({ cause }),
    }).pipe(Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(WasmStep))));
    if (terminal.kind !== "done") return yield* new WasmFailure({ cause: "Missing parent exit" });
    return terminal.output;
  }).pipe(
    Effect.onError(() =>
      Effect.gen(function* () {
        yield* Scope.close(family, Exit.void);
        yield* kernelCall(() => kernel.restore_manifest(state.checkpoint)).pipe(Effect.orDie);
      }),
    ),
  );
});
