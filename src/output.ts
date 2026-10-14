import type { Effect } from "effect";
import type { CapturedStdio, Fault } from "./contracts";
import type { StorageFailure } from "./storage";

export type OutputCapture = (
  stdio: typeof CapturedStdio.Type,
) => Effect.Effect<void, StorageFailure | Fault>;
