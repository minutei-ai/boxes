import { Effect, Schema } from "effect";
import { HostCall, Fault } from "./contracts";
import type { StorageFailure } from "./storage";

export class HostFailure extends Schema.TaggedError<HostFailure>()("HostFailure", {
  cause: Schema.Unknown,
}) {}

export type HostBridge = (
  request: typeof HostCall.Type,
) => Effect.Effect<Schema.Json, Fault | HostFailure | Schema.SchemaError | StorageFailure>;
