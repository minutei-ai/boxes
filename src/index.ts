import { WorkerEntrypoint } from "cloudflare:workers";
import { Clock, Effect, Match, Schema } from "effect";
import wasm from "cirro:wasm";
import { initSync, Kernel } from "../dist/wasm/cirro_kernel";
import { administrator, authorize, mint, requirePermission } from "./auth";
import {
  Action,
  Capability,
  CreateSandbox,
  DirectoryEntries,
  ErrorResponse,
  Fault,
  FileContent,
  FileStat,
  GuestAction,
  Head,
  Id,
  Policy,
  MintCapability,
  NetworkResult,
  RunRecord,
  ProcessPage,
  Status,
  Success,
  TokenResponse,
} from "./contracts";
import { filesystem } from "./filesystem";
import { HttpFailure, readBounded } from "./http";
import { inspect, list, run } from "./process";
import { kernelCall, open, publish, StorageFailure } from "./storage";
import type { Env } from "./resources";

initSync({ module: wasm });

declare global {
  namespace Cloudflare {
    interface GlobalProps {
      mainModule: typeof import("./index");
    }
  }
}

const Exists = Schema.Struct({ exists: Schema.Boolean });
const Link = Schema.Struct({ target: Schema.String });
const guestAction = Effect.fn("guest.action")(function* (
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

export class Guest extends WorkerEntrypoint<Env, typeof Capability.Type> {
  call(input: unknown) {
    return Effect.runPromise(
      Effect.scoped(
        Effect.gen({ self: this }, function* () {
          const action = yield* Schema.decodeUnknownEffect(GuestAction, {
            onExcessProperty: "error",
          })(input);
          return yield* guestAction(this.env, this.ctx.props, action);
        }),
      ),
    );
  }
}

const route = Effect.fn("api.route")(function* (request: Request, env: Env, ctx: ExecutionContext) {
  const url = new URL(request.url);
  if (request.method === "GET" && url.pathname === "/v1/schema")
    return Response.json(Schema.toJsonSchemaDocument(Action), {
      headers: { "cache-control": "public, max-age=3600" },
    });
  if (request.method === "GET" && url.pathname === "/health")
    return new Response("cirro", { headers: { "cache-control": "no-store" } });
  if (request.method !== "POST")
    return yield* new Fault({ code: "METHOD_NOT_ALLOWED", status: 405, message: "Use POST" });
  const authorization = request.headers.get("authorization");
  if (!authorization?.startsWith("Bearer "))
    return yield* new Fault({
      code: "UNAUTHORIZED",
      status: 401,
      message: "Bearer credential required",
    });
  const token = authorization.slice(7);
  if (url.pathname === "/v1/sandboxes") {
    yield* administrator(env, token);
    const bytes = yield* readBounded(request.body, 16_384);
    const input = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(CreateSandbox), {
      onExcessProperty: "error",
    })(bytes.toString("utf8"));
    const createdAt = yield* Clock.currentTimeMillis;
    const kernel = yield* Effect.acquireRelease(
      kernelCall(() => new Kernel()),
      (kernel) => Effect.sync(() => kernel.free()),
    );
    const manifest = yield* kernelCall(() => kernel.manifest());
    const record: typeof Head.Type = { manifest, policy: input.policy, createdAt, deleted: false };
    const object = yield* Effect.tryPromise({
      try: () =>
        env.OBJECTS.put(
          `sandboxes/${input.id}/head.json`,
          Schema.encodeSync(Schema.fromJsonString(Head))(record),
          { onlyIf: { etagDoesNotMatch: "*" } },
        ),
      catch: (cause) => new StorageFailure({ cause }),
    });
    if (object === null)
      return yield* new Fault({
        code: "EEXIST",
        status: 409,
        message: "Sandbox ID already exists",
      });
    return new Response(
      Schema.encodeSync(Schema.fromJsonString(Status))({
        id: input.id,
        generation: 0,
        filesystemBytes: 0,
        policy: input.policy,
      }),
      { status: 201, headers: { "content-type": "application/json", "cache-control": "no-store" } },
    );
  }
  const parts = url.pathname.split("/");
  if (parts.length !== 5 || parts[1] !== "v1" || parts[2] !== "sandboxes")
    return yield* new Fault({ code: "NOT_FOUND", status: 404, message: "Unknown API route" });
  const id = yield* Schema.decodeUnknownEffect(Id)(parts[3]);
  if (parts[4] === "capabilities") {
    yield* administrator(env, token);
    yield* open(env, id);
    const data = yield* readBounded(request.body, 4096);
    const input = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(MintCapability), {
      onExcessProperty: "error",
    })(data.toString("utf8"));
    const now = yield* Clock.currentTimeMillis;
    const expiresAt = now + input.expiresInSeconds * 1000;
    const scopedToken = yield* mint(env, {
      sandboxId: id,
      permissions: input.permissions,
      expiresAt,
    });
    return new Response(
      Schema.encodeSync(Schema.fromJsonString(TokenResponse))({ token: scopedToken, expiresAt }),
      { headers: { "content-type": "application/json", "cache-control": "no-store" } },
    );
  }
  if (parts[4] !== "action")
    return yield* new Fault({ code: "NOT_FOUND", status: 404, message: "Unknown API route" });
  const capability = yield* authorize(env, token, id);
  const data = yield* readBounded(request.body, 22_400_000);
  const action = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Action), {
    onExcessProperty: "error",
  })(data.toString("utf8"));
  const value = yield* Match.value(action).pipe(
    Match.when({ op: "process.run" }, (action) =>
      run(env, ctx, capability, action).pipe(
        Effect.map((result) => Schema.encodeSync(Schema.fromJsonString(RunRecord))(result)),
      ),
    ),
    Match.when({ op: "process.get" }, (action) =>
      inspect(env, capability, action.id).pipe(
        Effect.map((result) => Schema.encodeSync(Schema.fromJsonString(RunRecord))(result)),
      ),
    ),
    Match.when({ op: "process.list" }, (action) =>
      list(env, capability, action).pipe(
        Effect.map((page) => Schema.encodeSync(Schema.fromJsonString(ProcessPage))(page)),
      ),
    ),
    Match.when({ op: "config.get" }, () =>
      Effect.gen(function* () {
        yield* requirePermission(capability, "read");
        const session = yield* open(env, id);
        return Schema.encodeSync(Schema.fromJsonString(Policy))(session.head.policy);
      }),
    ),
    Match.when({ op: "config.set" }, (action) =>
      Effect.gen(function* () {
        yield* requirePermission(capability, "manage");
        const session = yield* open(env, id);
        yield* publish(env, id, { ...session, head: { ...session.head, policy: action.policy } });
        return Schema.encodeSync(Schema.fromJsonString(Policy))(action.policy);
      }),
    ),
    Match.when({ op: "config.patch" }, (action) =>
      Effect.gen(function* () {
        yield* requirePermission(capability, "manage");
        const session = yield* open(env, id);
        const policy = { ...session.head.policy, ...action.policy };
        yield* publish(env, id, { ...session, head: { ...session.head, policy } });
        return Schema.encodeSync(Schema.fromJsonString(Policy))(policy);
      }),
    ),
    Match.when({ op: "vm.status" }, () =>
      Effect.gen(function* () {
        yield* requirePermission(capability, "read");
        const session = yield* open(env, id);
        return Schema.encodeSync(Schema.fromJsonString(Status))({
          id,
          generation: Number(session.kernel.generation()),
          filesystemBytes: Number(session.kernel.bytes()),
          policy: session.head.policy,
        });
      }),
    ),
    Match.when({ op: "vm.dispose" }, () =>
      Effect.gen(function* () {
        yield* requirePermission(capability, "manage");
        const session = yield* open(env, id);
        const removed = { ...session, head: { ...session.head, deleted: true } };
        yield* publish(env, id, removed);
        return Schema.encodeSync(Schema.fromJsonString(Success))({ ok: true });
      }),
    ),
    Match.orElse((action) =>
      guestAction(env, capability, action).pipe(
        Effect.map((result) => {
          if (action.op === "network.fetch")
            return Schema.encodeUnknownSync(Schema.fromJsonString(NetworkResult))(result);
          return Match.value(action).pipe(
            Match.when({ op: "filesystem.readFile" }, () =>
              Schema.encodeUnknownSync(Schema.fromJsonString(FileContent))(result),
            ),
            Match.when({ op: "filesystem.stat" }, () =>
              Schema.encodeUnknownSync(Schema.fromJsonString(FileStat))(result),
            ),
            Match.when({ op: "filesystem.readdir" }, () =>
              Schema.encodeUnknownSync(Schema.fromJsonString(DirectoryEntries))(result),
            ),
            Match.when({ op: "filesystem.exists" }, () =>
              Schema.encodeUnknownSync(Schema.fromJsonString(Exists))(result),
            ),
            Match.when({ op: "filesystem.readlink" }, () =>
              Schema.encodeUnknownSync(Schema.fromJsonString(Link))(result),
            ),
            Match.orElse(() => Schema.encodeUnknownSync(Schema.fromJsonString(Success))(result)),
          );
        }),
      ),
    ),
  );
  return new Response(value, {
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
});

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext) {
    return Effect.runPromise(
      Effect.scoped(route(request, env, ctx)).pipe(
        Effect.catchTag("Fault", (fault) =>
          Effect.succeed(
            new Response(
              Schema.encodeSync(Schema.fromJsonString(ErrorResponse))({
                error: fault.code,
                message: fault.message,
              }),
              {
                status: fault.status,
                headers: { "content-type": "application/json", "cache-control": "no-store" },
              },
            ),
          ),
        ),
        Effect.catchTag("SchemaError", () =>
          Effect.succeed(
            new Response(
              Schema.encodeSync(Schema.fromJsonString(ErrorResponse))({
                error: "INVALID_INPUT",
                message: "Request does not match the API contract",
              }),
              {
                status: 400,
                headers: { "content-type": "application/json", "cache-control": "no-store" },
              },
            ),
          ),
        ),
        Effect.catchCause((cause) => {
          console.error("Cirro request failed", cause);
          return Effect.succeed(
            new Response(
              Schema.encodeSync(Schema.fromJsonString(ErrorResponse))({
                error: "INTERNAL",
                message: "Operation failed; inspect persisted state before retrying a write",
              }),
              {
                status: 500,
                headers: { "content-type": "application/json", "cache-control": "no-store" },
              },
            ),
          );
        }),
      ),
    );
  },
};
