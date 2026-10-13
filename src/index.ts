import { Cause, Clock, Effect, Match, Schema } from "effect";
import wasm from "cirro:wasm";
import { initSync, Kernel } from "../dist/kernel/cirro_kernel";
import { administrator, authorize, mint, requirePermission } from "./auth";
import {
  Action,
  SoftwareCatalog,
  PackagePreparation,
  BatchReadResults,
  BatchWriteResults,
  DirectoryTree,
  CanonicalPath,
  MigrationReceipt,
  CreateSandbox,
  DirectoryEntries,
  ErrorResponse,
  Fault,
  FileContent,
  FileStat,
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
import { guestAction } from "./capabilities";
import { migrate } from "./migration";
import { migrateFilesystem } from "./filesystem-migration";
import { migrateWasm } from "./wasm-migration";
import { readBounded } from "./http";
import { inspect, list, run, reserve, complete, wait } from "./process";
import { kernelCall, open, publish, StorageFailure } from "./storage";
import type { Env } from "./resources";

initSync({ module: wasm });

const Exists = Schema.Struct({ exists: Schema.Boolean });
const Link = Schema.Struct({ target: Schema.String });

const route = Effect.fn("api.route")(function* (
  request: Request,
  env: Env,
  executionContext: ExecutionContext,
) {
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
  if (url.pathname === "/v1/migrations/execution-policy-v2") {
    yield* administrator(env, token);
    const receipt = yield* migrate(env);
    return new Response(Schema.encodeSync(Schema.fromJsonString(MigrationReceipt))(receipt), {
      headers: { "content-type": "application/json", "cache-control": "no-store" },
    });
  }
  if (url.pathname === "/v1/migrations/wasm-inputs-v1") {
    yield* administrator(env, token);
    const receipt = yield* migrateWasm(env);
    return new Response(Schema.encodeSync(Schema.fromJsonString(MigrationReceipt))(receipt), {
      headers: { "content-type": "application/json", "cache-control": "no-store" },
    });
  }
  if (url.pathname === "/v1/migrations/filesystem-v3") {
    yield* administrator(env, token);
    const receipt = yield* migrateFilesystem(env);
    return new Response(Schema.encodeSync(Schema.fromJsonString(MigrationReceipt))(receipt), {
      headers: { "content-type": "application/json", "cache-control": "no-store" },
    });
  }
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
    yield* kernelCall(() => kernel.initialize_times(BigInt(createdAt) * 1_000_000n));
    const manifest = yield* kernelCall(() => kernel.manifest());
    const record: typeof Head.Type = {
      version: 2,
      manifest,
      policy: input.policy,
      createdAt,
      deleted: false,
    };
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
    Match.whenOr(
      { op: "process.run" },
      { op: "wasm.executeFile" },
      { op: "process.execFile" },
      { op: "javascript.execute" },
      { op: "javascript.evaluate" },
      { op: "javascript.executeFile" },
      { op: "typescript.execute" },
      { op: "typescript.evaluate" },
      { op: "typescript.executeFile" },
      { op: "python.execute" },
      { op: "python.evaluate" },
      { op: "python.executeFile" },
      (action) =>
        run(env, capability, action).pipe(
          Effect.map((result) => Schema.encodeSync(Schema.fromJsonString(RunRecord))(result)),
        ),
    ),
    Match.when({ op: "process.spawn" }, (action) =>
      Effect.gen(function* () {
        const reservation = yield* Effect.scoped(reserve(env, capability, action.execution));
        const background = Effect.scoped(complete(env, capability, reservation, 25_000)).pipe(
          Effect.catchCause((cause) =>
            Effect.sync(() =>
              console.error("Cirro background execution could not settle", Cause.pretty(cause)),
            ),
          ),
        );
        executionContext.waitUntil(Effect.runPromise(background));
        return Schema.encodeSync(Schema.fromJsonString(RunRecord))(reservation.record);
      }),
    ),
    Match.when({ op: "process.wait" }, (action) =>
      wait(env, capability, action).pipe(
        Effect.map((record) => Schema.encodeSync(Schema.fromJsonString(RunRecord))(record)),
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
            Match.when({ op: "software.install" }, () =>
              Schema.encodeUnknownSync(Schema.fromJsonString(PackagePreparation.fields.installed))(
                result,
              ),
            ),
            Match.whenOr({ op: "software.list" }, { op: "software.installed" }, () =>
              Schema.encodeUnknownSync(Schema.fromJsonString(SoftwareCatalog))(result),
            ),
            Match.when({ op: "filesystem.readFiles" }, () =>
              Schema.encodeUnknownSync(Schema.fromJsonString(BatchReadResults))(result),
            ),
            Match.when({ op: "filesystem.writeFiles" }, () =>
              Schema.encodeUnknownSync(Schema.fromJsonString(BatchWriteResults))(result),
            ),
            Match.when({ op: "filesystem.readdirRecursive" }, () =>
              Schema.encodeUnknownSync(Schema.fromJsonString(DirectoryTree))(result),
            ),
            Match.when({ op: "filesystem.realpath" }, () =>
              Schema.encodeUnknownSync(Schema.fromJsonString(CanonicalPath))(result),
            ),
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
  fetch(request: Request, env: Env, executionContext: ExecutionContext) {
    return Effect.runPromise(
      Effect.scoped(route(request, env, executionContext)).pipe(
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
          console.error(Cause.pretty(cause));
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
