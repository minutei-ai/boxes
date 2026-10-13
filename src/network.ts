import { Clock, Effect } from "effect";
import { requirePermission } from "./auth";
import { Capability, Fault, Policy } from "./contracts";
import { HttpFailure } from "./http";

export const fetchAuthorized = Effect.fn("network.fetch")(function* (
  capability: typeof Capability.Type,
  policy: typeof Policy.Type,
  address: string,
) {
  yield* requirePermission(capability, "network");
  const now = yield* Clock.currentTimeMillis;
  if (capability.expiresAt <= now)
    return yield* new Fault({ code: "UNAUTHORIZED", status: 401, message: "Capability expired" });
  const url = yield* Effect.try({
    try: () => new URL(address),
    catch: () => new Fault({ code: "EINVAL", status: 400, message: "Invalid network URL" }),
  });
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    (url.port && url.port !== "443") ||
    /^\d+(\.|$)/.test(url.hostname) ||
    !policy.networkHosts.includes(url.hostname)
  )
    return yield* new Fault({
      code: "FORBIDDEN",
      status: 403,
      message: "Destination is not authorized by the sandbox policy",
    });
  return yield* Effect.tryPromise({
    try: () => fetch(url, { redirect: "manual", signal: AbortSignal.timeout(10_000) }),
    catch: (cause) => new HttpFailure({ cause }),
  });
});
