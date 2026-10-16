import { Schema } from "effect";
import {
  ContextRecord,
  Digest,
  HostCall,
  Id,
  MemoryPages,
  RunResult,
  ScriptProgram,
} from "../../src/contracts";

export const ContextMemory = Schema.Struct({
  version: Schema.Literal(2),
  runtime: Digest,
  ...MemoryPages.fields,
  handle: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 4294967295 })),
});
const PageStorage = Schema.Struct({
  pages: Schema.Int,
  uniquePages: Schema.Int,
  pageWrites: Schema.Int,
});
const Resume = Schema.Struct({ hash: Digest, reply: Schema.Number });
export const ContextCheckpointRequest = Schema.Union([
  Schema.Struct({ op: Schema.Literal("pages") }),
  Schema.Struct({ op: Schema.Literal("save"), program: ScriptProgram }),
  Schema.Struct({ op: Schema.Literal("save-reused"), program: ScriptProgram }),
  Schema.Struct({ op: Schema.Literal("resume"), ...Resume.fields }),
  Schema.Struct({ op: Schema.Literal("reenter"), ...Resume.fields, program: ScriptProgram }),
  Schema.Struct({ op: Schema.Literal("continue"), hash: Digest, program: ScriptProgram }),
]);
export const ContextCheckpointProof = Schema.Union([
  Schema.Struct({
    op: Schema.Literal("pages"),
    first: PageStorage,
    unchanged: PageStorage,
    changed: PageStorage,
    restoredBytes: Schema.Array(Schema.Int),
    storedPages: Schema.Int,
    rejectedLayouts: Schema.Array(Schema.String),
  }),
  Schema.Struct({
    op: Schema.Literal("saved"),
    hash: Digest,
    request: HostCall,
    storage: PageStorage,
  }),
  Schema.Struct({ op: Schema.Literal("resumed"), output: RunResult }),
  Schema.Struct({
    op: Schema.Literal("reentered"),
    previous: RunResult,
    output: RunResult,
    hash: Digest,
    storage: PageStorage,
  }),
  Schema.Struct({
    op: Schema.Literal("continued"),
    output: RunResult,
    hash: Digest,
    storage: PageStorage,
  }),
  Schema.Struct({ op: Schema.Literal("isolation-denied"), message: Schema.String }),
]);

export const ContextClaimProof = Schema.Struct({
  claims: Schema.Array(Id),
  epochs: Schema.Array(Schema.String),
  sameIdleEtag: Schema.Boolean,
  staleRejected: Schema.Boolean,
  heldState: ContextRecord.fields.state,
});
