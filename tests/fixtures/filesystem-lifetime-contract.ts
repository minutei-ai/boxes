import { Schema } from "effect";

export const FilesystemUsage = Schema.Struct({
  status: Schema.Int,
  body: Schema.String,
  counts: Schema.Struct({
    headGets: Schema.Int,
    conditionalHeadGets: Schema.Int,
    fullHeadBodies: Schema.Int,
    headBodyBytes: Schema.Int,
    headPuts: Schema.Int,
  }),
  kernelMemoryBefore: Schema.Int,
  kernelMemoryAfter: Schema.Int,
  elapsedMs: Schema.Number,
});
