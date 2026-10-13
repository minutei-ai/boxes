import { Clock, Effect } from "effect";
import { requirePermission } from "./auth";
import { Capability, Fault, NetworkRequest, Policy } from "./contracts";
import { HttpFailure } from "./http";

export const fetchAuthorized = Effect.fn("network.fetch")(function* (
  capability: typeof Capability.Type,
  policy: typeof Policy.Type,
  address: string,
  input: typeof NetworkRequest.Type = {},
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
  const entries = Object.entries(input.headers ?? {});
  if (
    entries.length > 128 ||
    entries.reduce((total, [key, value]) => total + key.length + value.length, 0) > 65_536
  )
    return yield* new Fault({
      code: "EFBIG",
      status: 413,
      message: "Request headers exceed the limit",
    });
  for (const [name] of entries) {
    if (
      [
        "host",
        "connection",
        "upgrade",
        "content-length",
        "transfer-encoding",
        "trailer",
        "te",
        "proxy-authorization",
        "proxy-connection",
      ].includes(name.toLowerCase())
    )
      return yield* new Fault({
        code: "EINVAL",
        status: 400,
        message: "Transport headers are managed by the Worker",
      });
  }
  const headers = yield* Effect.try({
    try: () => new Headers(entries),
    catch: () => new Fault({ code: "EINVAL", status: 400, message: "Invalid HTTP headers" }),
  });
  const method = input.method ?? "GET";
  if ((method === "GET" || method === "HEAD") && input.body !== undefined)
    return yield* new Fault({
      code: "EINVAL",
      status: 400,
      message: "GET and HEAD do not accept a request body",
    });
  const body = yield* Effect.gen(function* () {
    if (input.body === undefined) return undefined;
    const { content, encoding } = input.body;
    if (
      encoding === "base64" &&
      (content.length % 4 !== 0 ||
        !/^[A-Za-z0-9+/]*={0,2}$/.test(content) ||
        Buffer.from(content.slice(-4), "base64").toString("base64") !== content.slice(-4))
    )
      return yield* new Fault({ code: "EINVAL", status: 400, message: "Invalid canonical base64" });
    const bytes = Buffer.from(content, encoding);
    if (bytes.byteLength > 1_048_576)
      return yield* new Fault({
        code: "EFBIG",
        status: 413,
        message: "Request body exceeds 1 MiB",
      });
    return bytes;
  });
  return yield* Effect.tryPromise({
    try: () =>
      fetch(url, {
        method,
        headers,
        body,
        redirect: "manual",
        signal: AbortSignal.timeout(10_000),
      }),
    catch: (cause) => new HttpFailure({ cause }),
  });
});
