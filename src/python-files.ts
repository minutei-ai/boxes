import { Clock, Effect, Match, Schema } from "effect";
import {
  Capability,
  ContentBlock,
  FileStat,
  Fault,
  Path,
  ReadPlan,
  RangeWritePlan,
} from "./contracts";
import { requirePermission } from "./auth";
import { applyWritePlan, block, kernelCall, open, publish } from "./storage";
import type { Env } from "./resources";

export const PythonFileSnapshot = Schema.Struct({
  stat: FileStat,
  blocks: Schema.Array(ContentBlock).check(Schema.isMaxLength(64)),
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
    forWrite: Schema.Boolean,
    snapshot: PythonFileSnapshot,
    offset: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER })),
    length: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 262_144 })),
  }),
  Schema.Struct({ op: Schema.Literal("python.file.stat"), snapshot: PythonFileSnapshot }),
  Schema.Struct({
    op: Schema.Literal("python.file.write"),
    snapshot: PythonFileSnapshot,
    offset: Schema.NullOr(
      Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER })),
    ),
    content: Schema.String.check(Schema.isMaxLength(349528)),
  }),
  Schema.Struct({
    op: Schema.Literal("python.file.resize"),
    snapshot: PythonFileSnapshot,
    size: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 16777216 })),
  }),
]);
export const PythonFileRead = Schema.Struct({
  snapshot: PythonFileSnapshot,
  content: Schema.String,
});
const DetachedFile = Schema.Struct({ detached: Schema.Literal(true), nowNs: Schema.String });
const PythonFileWrite = Schema.Struct({
  snapshot: PythonFileSnapshot,
  offset: Schema.Int,
  count: Schema.Int,
});
export const pythonFile = Effect.fn("python.file")(function* (
  env: Env,
  capability: typeof Capability.Type,
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
    if (action.forWrite) yield* requirePermission(capability, "write");
    else yield* requirePermission(capability, "read");
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
    if (changed) yield* publish(env, capability.sandboxId, session);
    const stat = yield* kernelCall(() => kernel.stat(action.path, true)).pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(FileStat))),
    );
    const plan = yield* kernelCall(() =>
      kernel.read_inode_plan(BigInt(stat.inode), 0n, 16777216n),
    ).pipe(Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(ReadPlan))));
    return new TextEncoder().encode(
      Schema.encodeSync(Schema.fromJsonString(PythonFileSnapshot))({ stat, blocks: plan.blocks }),
    );
  }
  if (action.op === "python.file.write" || action.op === "python.file.resize") {
    const inode = BigInt(action.snapshot.stat.inode);
    const linked = yield* kernelCall(() => kernel.inode_path(inode));
    if (linked === undefined)
      return new TextEncoder().encode(
        Schema.encodeSync(Schema.fromJsonString(DetachedFile))({
          detached: true,
          nowNs: yieldedTime.toString(),
        }),
      );
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
    const stat = yield* kernelCall(() => kernel.stat_inode(inode)).pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(FileStat))),
    );
    const blocks = yield* kernelCall(() => kernel.read_inode_plan(inode, 0n, 16777216n)).pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(ReadPlan))),
    );
    const snapshot = { stat, blocks: blocks.blocks };
    if (action.op === "python.file.resize")
      return new TextEncoder().encode(
        Schema.encodeSync(Schema.fromJsonString(PythonFileSnapshot))(snapshot),
      );
    return new TextEncoder().encode(
      Schema.encodeSync(Schema.fromJsonString(PythonFileWrite))({
        snapshot,
        offset: plan.offset + data.byteLength,
        count: data.byteLength,
      }),
    );
  }
  const found = yield* kernelCall(() => kernel.stat_inode(BigInt(action.snapshot.stat.inode))).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(FileStat))),
    Effect.result,
  );
  const snapshot = yield* Effect.gen(function* () {
    if (found._tag === "Failure") {
      if (found.failure._tag !== "Fault" || found.failure.code !== "ENOENT")
        return yield* found.failure;
      return { ...action.snapshot, stat: { ...action.snapshot.stat, nlink: 0 } };
    }
    const plan = yield* kernelCall(() =>
      kernel.read_inode_plan(BigInt(found.success.inode), 0n, 16_777_216n),
    ).pipe(Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(ReadPlan))));
    return { stat: found.success, blocks: plan.blocks };
  });
  if (action.op === "python.file.stat")
    return new TextEncoder().encode(
      Schema.encodeSync(Schema.fromJsonString(PythonFileSnapshot))(snapshot),
    );
  const length = Math.min(action.length, Math.max(0, snapshot.stat.size - action.offset));
  if (length === 0)
    return new TextEncoder().encode(
      Schema.encodeSync(Schema.fromJsonString(PythonFileRead))({ snapshot, content: "" }),
    );
  const first = Math.floor(action.offset / 262_144);
  const references = snapshot.blocks.slice(
    first,
    first + Math.ceil(((action.offset % 262_144) + length) / 262_144),
  );
  const data = yield* Effect.forEach(
    references,
    (reference) => block(env, capability.sandboxId, reference),
    { concurrency: 2 },
  );
  const content = Buffer.concat(data).subarray(
    action.offset % 262_144,
    (action.offset % 262_144) + length,
  );
  return new TextEncoder().encode(
    Schema.encodeSync(Schema.fromJsonString(PythonFileRead))({
      snapshot,
      content: content.toString("base64"),
    }),
  );
}, Effect.scoped);
