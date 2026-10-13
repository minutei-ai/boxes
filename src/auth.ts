import { Clock, Effect, Schema } from "effect";
import { Capability, Fault } from "./contracts";
import type { Env } from "./resources";

export class CryptoFailure extends Schema.TaggedError<CryptoFailure>()("CryptoFailure", {
  cause: Schema.Unknown,
}) {}
export const administrator = Effect.fn("auth.administrator")(function* (env: Env, token: string) {
  const valid = yield* Effect.tryPromise({
    try: async () => {
      const key = await crypto.subtle.importKey(
        "raw",
        new TextEncoder().encode(env.API_KEY),
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["sign", "verify"],
      );
      const signature = await crypto.subtle.sign(
        "HMAC",
        key,
        new TextEncoder().encode(env.API_KEY),
      );
      return crypto.subtle.verify("HMAC", key, signature, new TextEncoder().encode(token));
    },
    catch: (cause) => new CryptoFailure({ cause }),
  });
  if (!valid)
    return yield* new Fault({
      code: "UNAUTHORIZED",
      status: 401,
      message: "Administrator credential required",
    });
});

export const mint = Effect.fn("auth.mint")(function* (
  env: Env,
  capability: typeof Capability.Type,
) {
  const payload = Buffer.from(
    Schema.encodeSync(Schema.fromJsonString(Capability))(capability),
  ).toString("base64url");
  const signature = yield* Effect.tryPromise({
    try: async () => {
      const key = await crypto.subtle.importKey(
        "raw",
        new TextEncoder().encode(env.API_KEY),
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["sign"],
      );
      return crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload));
    },
    catch: (cause) => new CryptoFailure({ cause }),
  });
  return `${payload}.${Buffer.from(signature).toString("base64url")}`;
});

export const authorize = Effect.fn("auth.authorize")(function* (
  env: Env,
  token: string,
  id: string,
) {
  const pieces = token.split(".");
  if (pieces.length !== 2 || token.length > 2048)
    return yield* new Fault({
      code: "UNAUTHORIZED",
      status: 401,
      message: "Scoped capability required",
    });
  const payload = pieces[0];
  const signature = pieces[1];
  const valid = yield* Effect.tryPromise({
    try: async () => {
      const key = await crypto.subtle.importKey(
        "raw",
        new TextEncoder().encode(env.API_KEY),
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["verify"],
      );
      return crypto.subtle.verify(
        "HMAC",
        key,
        Buffer.from(signature, "base64url"),
        new TextEncoder().encode(payload),
      );
    },
    catch: (cause) => new CryptoFailure({ cause }),
  });
  if (!valid)
    return yield* new Fault({
      code: "UNAUTHORIZED",
      status: 401,
      message: "Invalid capability signature",
    });
  const capability = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Capability))(
    Buffer.from(payload, "base64url").toString("utf8"),
  );
  const now = yield* Clock.currentTimeMillis;
  if (capability.sandboxId !== id || capability.expiresAt <= now)
    return yield* new Fault({
      code: "UNAUTHORIZED",
      status: 401,
      message: "Capability expired or belongs to another sandbox",
    });
  return capability;
});

export const requirePermission = Effect.fn("auth.permission")(function* (
  capability: typeof Capability.Type,
  permission: (typeof Capability.Type.permissions)[number],
) {
  if (!capability.permissions.includes(permission))
    return yield* new Fault({
      code: "FORBIDDEN",
      status: 403,
      message: `Capability does not grant ${permission}`,
    });
});
