import { Schema } from "effect";
import { Digest, HostCall, RunResult, ScriptProgram } from "../../src/contracts";

export const ContextMemory = Schema.Struct({
  version: Schema.Literal(1),
  runtime: Digest,
  digest: Digest,
  memoryBytes: Schema.Int.check(Schema.isBetween({ minimum: 65536, maximum: 16777216 })),
  handle: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 4294967295 })),
});
const Resume = Schema.Struct({ hash: Digest, reply: Schema.Number });
export const ContextCheckpointRequest = Schema.Union([
  Schema.Struct({ op: Schema.Literal("save"), program: ScriptProgram }),
  Schema.Struct({ op: Schema.Literal("save-reused"), program: ScriptProgram }),
  Schema.Struct({ op: Schema.Literal("resume"), ...Resume.fields }),
  Schema.Struct({ op: Schema.Literal("reenter"), ...Resume.fields, program: ScriptProgram }),
  Schema.Struct({ op: Schema.Literal("continue"), hash: Digest, program: ScriptProgram }),
]);
export const ContextCheckpointProof = Schema.Union([
  Schema.Struct({ op: Schema.Literal("saved"), hash: Digest, request: HostCall }),
  Schema.Struct({ op: Schema.Literal("resumed"), output: RunResult }),
  Schema.Struct({
    op: Schema.Literal("reentered"),
    previous: RunResult,
    output: RunResult,
    hash: Digest,
  }),
  Schema.Struct({ op: Schema.Literal("continued"), output: RunResult, hash: Digest }),
  Schema.Struct({ op: Schema.Literal("isolation-denied"), message: Schema.String }),
]);
