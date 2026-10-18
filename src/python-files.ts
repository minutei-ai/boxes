import { Clock, Effect, Match, Schema } from "effect";
import {
  Capability,
  ContextReference,
  FileStat,
  Fault,
  Path,
  ReadPlan,
  RangeWritePlan,
} from "./contracts";
import { requirePermission } from "./auth";
import { applyWritePlan, block, kernelCall, open, publish } from "./storage";
import type { Env } from "./resources";

export const PythonFileOwner = Schema.Struct({
  id: Schema.NonEmptyString.check(Schema.isMaxLength(256)),
  generation: ContextReference.fields.generation,
});

export const PythonFileAction = Schema.Union([
  Schema.Struct({
    op: Schema.Literal("python.file.open"),
    path: Path,
    access: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 3 })),
    creation: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 7 })),
    mode: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 511 })),
  }),
  Schema.Struct({
    op: Schema.Literal("python.file.read"),
    inode: FileStat.fields.inode,
    offset: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER })),
    length: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 262_144 })),
  }),
  Schema.Struct({ op: Schema.Literal("python.file.stat"), inode: FileStat.fields.inode }),
  Schema.Struct({ op: Schema.Literal("python.file.close"), inode: FileStat.fields.inode }),
  Schema.Struct({
    op: Schema.Literal("python.file.write"),
    inode: FileStat.fields.inode,
    offset: Schema.NullOr(
      Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER })),
    ),
    content: Schema.String.check(Schema.isMaxLength(349528)),
  }),
  Schema.Struct({
    op: Schema.Literal("python.file.resize"),
    inode: FileStat.fields.inode,
    size: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 16777216 })),
  }),
]);
const PythonFileRead = Schema.Struct({ content: Schema.String });
const PythonFileWrite = Schema.Struct({
  offset: Schema.Int,
  count: Schema.Int,
});
export const pythonFile = Effect.fn("python.file")(function* (
  env: Env,
  capability: typeof Capability.Type,
  owner: typeof PythonFileOwner.Type,
  action: typeof PythonFileAction.Type,
) {
  if (capability.expiresAt <= (yield* Clock.currentTimeMillis))
    return yield* new Fault({ code: "UNAUTHORIZED", status: 401, message: "Capability expired" });
  if (action.op === "python.file.open") {
    if ((action.access & 1) !== 0) yield* requirePermission(capability, "read");
    if ((action.access & 2) !== 0 || (action.creation & 1) !== 0)
      yield* requirePermission(capability, "write");
  } else if (action.op === "python.file.write" || action.op === "python.file.resize") {
    yield* requirePermission(capability, "write");
  } else if (action.op === "python.file.read") {
    yield* requirePermission(capability, "read");
  } else if (action.op === "python.file.close") {
    yield* requirePermission(capability, "execute");
  } else if (!capability.permissions.includes("write")) {
    yield* requirePermission(capability, "read");
  }
  const session = yield* open(env, capability.sandboxId);
  const kernel = session.kernel;
  const yieldedTime = yield* Clock.currentTimeNanos;
  yield* kernelCall(() => kernel.set_time(yieldedTime));
  if (action.op === "python.file.open") {
    const changed = yield* kernelCall(() =>
      kernel.open_regular(action.path, action.access, action.creation, action.mode),
    );
    const stat = yield* kernelCall(() => kernel.stat(action.path, true)).pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(FileStat))),
    );
    const released = yield* Effect.sync(() => {
      if (owner.generation === 0) return false;
      return kernel.release_inode_owner(owner.id, BigInt(owner.generation - 1));
    });
    const retained = yield* kernelCall(() =>
      kernel.retain_inode(owner.id, BigInt(owner.generation), BigInt(stat.inode), stat.path),
    );
    if (changed || released || retained) yield* publish(env, capability.sandboxId, session);
    return new TextEncoder().encode(Schema.encodeSync(Schema.fromJsonString(FileStat))(stat));
  }
  const inode = BigInt(action.inode);
  if (action.op === "python.file.close") {
    const changed = yield* kernelCall(() =>
      kernel.release_inode(owner.id, BigInt(owner.generation), inode),
    );
    if (changed) yield* publish(env, capability.sandboxId, session);
    return new TextEncoder().encode(Schema.encodeSync(Schema.fromJsonString(Schema.Null))(null));
  }
  if (!kernel.retains_inode(owner.id, BigInt(owner.generation), inode))
    return yield* new Fault({
      code: "EBADF",
      status: 400,
      message: "Descriptor owner has no inode reference",
    });
  if (action.op === "python.file.write" || action.op === "python.file.resize") {
    const data = Match.value(action).pipe(
      Match.when({ op: "python.file.write" }, (write) => Buffer.from(write.content, "base64")),
      Match.orElse(() => Buffer.alloc(0)),
    );
    if (
      action.op === "python.file.write" &&
      (data.byteLength > 262144 || data.toString("base64") !== action.content)
    )
      return yield* new Fault({
        code: "EINVAL",
        status: 400,
        message: "Invalid native file write content",
      });
    const plan = yield* kernelCall(() => {
      if (action.op === "python.file.resize")
        return kernel.resize_inode_plan(inode, BigInt(action.size));
      if (action.offset === null)
        return kernel.write_inode_range_plan(inode, undefined, BigInt(data.byteLength));
      return kernel.write_inode_range_plan(inode, BigInt(action.offset), BigInt(data.byteLength));
    }).pipe(Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(RangeWritePlan))));
    if (yield* applyWritePlan(env, capability.sandboxId, kernel, plan, data, inode))
      yield* publish(env, capability.sandboxId, session);
    if (action.op === "python.file.resize")
      return new TextEncoder().encode(Schema.encodeSync(Schema.fromJsonString(Schema.Null))(null));
    return new TextEncoder().encode(
      Schema.encodeSync(Schema.fromJsonString(PythonFileWrite))({
        offset: plan.offset + data.byteLength,
        count: data.byteLength,
      }),
    );
  }
  if (action.op === "python.file.stat") {
    const stat = yield* kernelCall(() => kernel.stat_inode(inode)).pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(FileStat))),
    );
    return new TextEncoder().encode(Schema.encodeSync(Schema.fromJsonString(FileStat))(stat));
  }
  const plan = yield* kernelCall(() =>
    kernel.read_inode_plan(inode, BigInt(action.offset), BigInt(action.length)),
  ).pipe(Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(ReadPlan))));
  const data = yield* Effect.forEach(
    plan.blocks,
    (reference) => block(env, capability.sandboxId, reference),
    { concurrency: 2 },
  );
  const content = Buffer.concat(data).subarray(plan.skip, plan.skip + plan.length);
  return new TextEncoder().encode(
    Schema.encodeSync(Schema.fromJsonString(PythonFileRead))({
      content: content.toString("base64"),
    }),
  );
}, Effect.scoped);

export const releasePythonFiles = Effect.fn("python.files.release")(
  function* (
    env: Env,
    sandboxId: typeof Capability.Type.sandboxId,
    owner: typeof PythonFileOwner.Type,
  ) {
    const opened = yield* open(env, sandboxId).pipe(Effect.result);
    if (opened._tag === "Failure") {
      if (opened.failure._tag === "Fault" && opened.failure.code === "ENOENT") return;
      return yield* opened.failure;
    }
    const session = opened.success;
    const changed = yield* kernelCall(() =>
      session.kernel.release_inode_owner(owner.id, BigInt(owner.generation)),
    );
    if (changed) yield* publish(env, sandboxId, session);
  },
  Effect.scoped,
  Effect.retry({
    times: 3,
    while: (failure) => failure._tag === "Fault" && failure.code === "CONFLICT",
  }),
);
