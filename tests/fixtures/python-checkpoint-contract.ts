import { Schema } from "effect";
import { Digest, MemoryPages, PythonProgram, RunResult } from "../../src/contracts";

export const PythonHeap = Schema.Struct({
  runtime: Digest,
  ...MemoryPages.fields,
  handle: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 4294967295 })),
});
export const PythonCheckpointRequest = Schema.Struct({
  hash: Schema.NullOr(Digest),
  program: PythonProgram,
  reply: Schema.Json,
});
export const PythonCheckpointProof = Schema.Struct({
  hash: Digest,
  output: RunResult,
  nonquiescentDenied: Schema.Boolean,
  duplicateHandleDenied: Schema.Boolean,
  puts: Schema.Int,
  reads: Schema.Int,
  memoryBytes: Schema.Int,
  uniquePages: Schema.Int,
  packs: Schema.Int,
});
