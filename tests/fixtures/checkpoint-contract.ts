import { Schema } from "effect";
import { WasmStep } from "../../src/contracts";
export const CheckpointRequest = Schema.Union([
  Schema.Struct({ op: Schema.Literal("save"), source: Schema.String }),
  Schema.Struct({ op: Schema.Literal("save-family"), source: Schema.String, child: Schema.String }),
  Schema.Struct({ op: Schema.Literal("resume"), hash: Schema.String }),
]);
export const CheckpointProof = Schema.Union([
  Schema.Struct({ op: Schema.Literal("saved"), hash: Schema.String, before: WasmStep }),
  Schema.Struct({
    op: Schema.Literal("resumed"),
    after: WasmStep,
    terminal: WasmStep,
    steps: Schema.Int,
    reads: Schema.Struct({
      pages: Schema.Int,
      uniquePages: Schema.Int,
      pageRequests: Schema.Int,
    }),
  }),
]);
