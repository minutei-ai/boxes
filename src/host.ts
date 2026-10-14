import { Effect, Schema } from "effect";
import { HostCall, Fault } from "./contracts";

export class HostFailure extends Schema.TaggedError<HostFailure>()("HostFailure", {
  cause: Schema.Unknown,
}) {}

export type HostBridge = (
  request: typeof HostCall.Type,
) => Effect.Effect<Schema.Json, Fault | HostFailure | Schema.SchemaError>;
