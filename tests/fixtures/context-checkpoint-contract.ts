import { Schema } from "effect";
import { Digest, HostCall, RunResult, ScriptProgram } from "../../src/contracts";

export const ContextMemory = Schema.Struct({
  version: Schema.Literal(1),
  runtime: Digest,
  digest: Digest,
  memoryBytes: Schema.Int.check(Schema.isBetween({ minimum: 65536, maximum: 16777216 })),
  handle: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 4294967295 })),
});
export const ContextCheckpointRequest = Schema.Union([
  Schema.Struct({ op: Schema.Literal("save"), program: ScriptProgram }),
  Schema.Struct({ op: Schema.Literal("save-reused"), program: ScriptProgram }),
  Schema.Struct({ op: Schema.Literal("resume"), hash: Digest, reply: Schema.Number }),
]);
export const ContextCheckpointProof = Schema.Union([
  Schema.Struct({ op: Schema.Literal("saved"), hash: Digest, request: HostCall }),
  Schema.Struct({ op: Schema.Literal("resumed"), output: RunResult }),
  Schema.Struct({ op: Schema.Literal("isolation-denied"), message: Schema.String }),
]);
