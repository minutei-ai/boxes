import { Clock, Effect } from "effect";
import { Capability, Fault, GuestAction, NetworkResult } from "./contracts";
import { filesystem } from "./filesystem";
import { readBounded } from "./http";
import { inspect, list } from "./process";
import { open } from "./storage";
import { fetchAuthorized } from "./network";
import { software } from "./software";
import type { Env } from "./resources";

export const guestAction = Effect.fn("guest.action")(function* (
  env: Env,
  capability: typeof Capability.Type,
  action: typeof GuestAction.Type,
) {
  const now = yield* Clock.currentTimeMillis;
  if (capability.expiresAt <= now)
    return yield* new Fault({ code: "UNAUTHORIZED", status: 401, message: "Capability expired" });
  if (action.op === "process.get") return yield* inspect(env, capability, action.id);
  if (action.op === "process.list") return yield* list(env, capability, action);
  if (action.op === "network.fetch") {
    const session = yield* open(env, capability.sandboxId);
    const response = yield* fetchAuthorized(capability, session.head.policy, action.url);
    const data = yield* readBounded(response.body, session.head.policy.maxOutputBytes);
    return {
      status: response.status,
      content: data.toString("base64"),
      encoding: "base64" as const,
    } satisfies typeof NetworkResult.Type;
  }
  if (
    action.op === "software.install" ||
    action.op === "software.uninstall" ||
    action.op === "software.link" ||
    action.op === "software.list" ||
    action.op === "software.installed"
  )
    return yield* software(env, capability, action);
  return yield* filesystem(env, capability, action);
});
