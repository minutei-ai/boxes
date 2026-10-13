import { Clock, Effect } from "effect";
import { requirePermission } from "./auth";
import { Capability, Fault, GuestAction, NetworkResult } from "./contracts";
import { filesystem } from "./filesystem";
import { HttpFailure, readBounded } from "./http";
import { inspect, list } from "./process";
import { open } from "./storage";
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
    yield* requirePermission(capability, "network");
    const session = yield* open(env, capability.sandboxId);
    const url = yield* Effect.try({
      try: () => new URL(action.url),
      catch: () => new Fault({ code: "EINVAL", status: 400, message: "Invalid network URL" }),
    });
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      (url.port && url.port !== "443") ||
      /^\d+(\.|$)/.test(url.hostname) ||
      !session.head.policy.networkHosts.includes(url.hostname)
    ) {
      return yield* new Fault({
        code: "FORBIDDEN",
        status: 403,
        message: "Destination is not authorized by the sandbox policy",
      });
    }
    const response = yield* Effect.tryPromise({
      try: () => fetch(url, { redirect: "manual", signal: AbortSignal.timeout(10_000) }),
      catch: (cause) => new HttpFailure({ cause }),
    });
    const data = yield* readBounded(response.body, session.head.policy.maxOutputBytes);
    return {
      status: response.status,
      content: data.toString("base64"),
      encoding: "base64" as const,
    } satisfies typeof NetworkResult.Type;
  }
  return yield* filesystem(env, capability, action);
});
