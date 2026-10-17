import { Clock, Effect, Schema } from "effect";
import { Capability, ContentBlock, FileStat, Fault, Path, ReadPlan } from "./contracts";
import { requirePermission } from "./auth";
import { block, kernelCall, open } from "./storage";
import type { Env } from "./resources";

export const PythonFileSnapshot = Schema.Struct({
  stat: FileStat,
  blocks: Schema.Array(ContentBlock).check(Schema.isMaxLength(64)),
});
export const PythonFileAction = Schema.Union([
  Schema.Struct({ op: Schema.Literal("python.file.openRead"), path: Path }),
  Schema.Struct({
    op: Schema.Literal("python.file.read"),
    snapshot: PythonFileSnapshot,
    offset: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER })),
    length: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 262_144 })),
  }),
  Schema.Struct({ op: Schema.Literal("python.file.stat"), snapshot: PythonFileSnapshot }),
]);
export const PythonFileRead = Schema.Struct({
  snapshot: PythonFileSnapshot,
  content: Schema.String,
});
export const pythonFile = Effect.fn("python.file")(function* (
  env: Env,
  capability: typeof Capability.Type,
  action: typeof PythonFileAction.Type,
) {
  if (capability.expiresAt <= (yield* Clock.currentTimeMillis))
    return yield* new Fault({ code: "UNAUTHORIZED", status: 401, message: "Capability expired" });
  yield* requirePermission(capability, "read");
  const session = yield* open(env, capability.sandboxId);
  const kernel = session.kernel;
  if (action.op === "python.file.openRead") {
    const stat = yield* kernelCall(() => kernel.stat(action.path, true)).pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(FileStat))),
    );
    const plan = yield* kernelCall(() =>
      kernel.read_plan(action.path, 0n, 16_777_216n, false),
    ).pipe(Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(ReadPlan))));
    return new TextEncoder().encode(
      Schema.encodeSync(Schema.fromJsonString(PythonFileSnapshot))({ stat, blocks: plan.blocks }),
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
