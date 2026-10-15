import { Cause, Clock, Effect, Match, Schema } from "effect";
import type { RpcStub } from "cloudflare:workers";
import wasm from "cirro:wasm";
import { initSync, Kernel } from "../dist/kernel/cirro_kernel";
import { administrator, authorize, mint, requirePermission } from "./auth";
import {
  Action,
  AgentRequest,
  AgentReply,
  HostCall,
  HostReply,
  ActionResponses,
  DispatchReceipt,
  MigrationReceipt,
  OutputMigrationInput,
  OutputMigrationReceipt,
  CreateSandbox,
  ErrorResponse,
  Fault,
  Head,
  Id,
  Policy,
  MintCapability,
  RunRecord,
  RunSummary,
  RecoveryStatus,
  ProcessPage,
  ProcessOutputPage,
  LiveOutputPage,
  InputReceipt,
  Status,
  Success,
  TokenResponse,
} from "./contracts";
import { input } from "./input";
import { HostFailure } from "./host";
import { AgentProtocol, type HostCallback } from "./rpc-protocol";
import { importSnapshot } from "./snapshot";
import { tick } from "./cron";
import { guestAction } from "./capabilities";
import { migrate } from "./migration";
import { migrateFilesystem } from "./filesystem-migration";
import { migrateProcesses, migrateOutput } from "./process-migration";
import { migrateWasm } from "./wasm-migration";
import { readBounded } from "./http";
import {
  inspect,
  list,
  run,
  spawn,
  dispatch,
  reconcile,
  wait,
  cancel,
  output,
  liveOutput,
  recoveryStatus,
} from "./process";
import { head, kernelCall, open, publish, dispose, StorageFailure } from "./storage";
import type { Env } from "./resources";

initSync({ module: wasm });

const route = Effect.fn("api.route")(function* (request: Request, env: Env) {
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
  if (url.pathname === "/v1/maintenance/process-dispatch") {
    yield* administrator(env, token);
    const input = yield* readBounded(request.body, 4096);
    yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Struct({})), {
      onExcessProperty: "error",
    })(input.toString("utf8"));
    const receipt = yield* reconcile(env);
    return new Response(Schema.encodeSync(Schema.fromJsonString(DispatchReceipt))(receipt), {
      headers: { "content-type": "application/json", "cache-control": "no-store" },
    });
  }
  if (url.pathname === "/v1/migrations/execution-policy-v2") {
    yield* administrator(env, token);
    const receipt = yield* migrate(env);
    return new Response(Schema.encodeSync(Schema.fromJsonString(MigrationReceipt))(receipt), {
      headers: { "content-type": "application/json", "cache-control": "no-store" },
    });
  }
  if (url.pathname === "/v1/migrations/process-receipts-v2") {
    yield* administrator(env, token);
    const receipt = yield* migrateProcesses(env);
    return new Response(Schema.encodeSync(Schema.fromJsonString(MigrationReceipt))(receipt), {
      headers: { "content-type": "application/json", "cache-control": "no-store" },
    });
  }
  if (url.pathname === "/v1/migrations/output-chunks-v1") {
    yield* administrator(env, token);
    const bytes = yield* readBounded(request.body, 4096);
    const input = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(OutputMigrationInput), {
      onExcessProperty: "error",
    })(bytes.toString("utf8"));
    const receipt = yield* migrateOutput(env, input.cursor ?? null);
    return new Response(Schema.encodeSync(Schema.fromJsonString(OutputMigrationReceipt))(receipt), {
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
    const bytes = yield* readBounded(request.body, 25_200_000);
    const input = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(CreateSandbox), {
      onExcessProperty: "error",
    })(bytes.toString("utf8"));
    const createdAt = yield* Clock.currentTimeMillis;
    const kernel = yield* Effect.acquireRelease(
      kernelCall(() => new Kernel()),
      (kernel) => Effect.sync(() => kernel.free()),
    );
    yield* kernelCall(() => kernel.initialize_times(BigInt(createdAt) * 1_000_000n));
    if (input.snapshot !== undefined) {
      const existing = yield* Effect.tryPromise({
        try: () => env.OBJECTS.head(`sandboxes/${input.id}/head.json`),
        catch: (cause) => new StorageFailure({ cause }),
      });
      if (existing !== null)
        return yield* new Fault({
          code: "EEXIST",
          status: 409,
          message: "Sandbox ID already exists",
        });
      yield* kernelCall(() => kernel.initialize_snapshot_root());
      yield* importSnapshot(env, input.id, kernel, input.snapshot);
    }
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
        generation: Number(kernel.generation()),
        filesystemBytes: Number(kernel.bytes()),
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
  const data = yield* readBounded(request.body, 25_200_000);
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
      spawn(env, capability, action.execution, action.stdinMode ?? "closed").pipe(
        Effect.map((record) => Schema.encodeSync(Schema.fromJsonString(RunRecord))(record)),
      ),
    ),
    Match.whenOr(
      { op: "process.stdin.write" },
      { op: "process.stdin.close" },
      { op: "process.stdin.status" },
      (action) =>
        input(env, capability, action).pipe(
          Effect.map((value) => Schema.encodeSync(Schema.fromJsonString(InputReceipt))(value)),
        ),
    ),
    Match.when({ op: "process.recovery.status" }, (action) =>
      recoveryStatus(env, capability, action).pipe(
        Effect.map((value) => Schema.encodeSync(Schema.fromJsonString(RecoveryStatus))(value)),
      ),
    ),
    Match.when({ op: "process.output.readLive" }, (action) =>
      liveOutput(env, capability, action).pipe(
        Effect.map((page) => Schema.encodeSync(Schema.fromJsonString(LiveOutputPage))(page)),
      ),
    ),
    Match.when({ op: "process.output.read" }, (action) =>
      output(env, capability, action).pipe(
        Effect.map((page) => Schema.encodeSync(Schema.fromJsonString(ProcessOutputPage))(page)),
      ),
    ),
    Match.when({ op: "process.cancel" }, (action) =>
      cancel(env, capability, action).pipe(
        Effect.map((record) => Schema.encodeSync(Schema.fromJsonString(RunSummary))(record)),
      ),
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
        yield* dispose(env, id);
        return Schema.encodeSync(Schema.fromJsonString(Success))({ ok: true });
      }),
    ),
    Match.orElse((action) =>
      guestAction(env, capability, action).pipe(
        Effect.map((result) =>
          Schema.encodeUnknownSync(Schema.fromJsonString(ActionResponses[action.op]))(result),
        ),
      ),
    ),
  );
  return new Response(value, {
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
});

export const consume = Effect.fn("worker.consume")((batch: MessageBatch<unknown>, env: Env) =>
  Effect.scoped(
    Effect.forEach(
      batch.messages,
      (message) =>
        dispatch(env, message.body).pipe(
          Effect.tap(() => Effect.sync(() => message.ack())),
          Effect.catchTag("ExecutionPending", (failure) =>
            Effect.sync(() => message.retry({ delaySeconds: failure.retryAfterSeconds })),
          ),
          Effect.catchCause((cause) =>
            Effect.sync(() => {
              console.error("Cirro dispatch failed", Cause.pretty(cause));
              message.retry({ delaySeconds: 30 });
            }),
          ),
        ),
      { concurrency: 1 },
    ),
  ),
);
export const handleRequest = Effect.fn("worker.request")((request: Request, env: Env) =>
  Effect.scoped(route(request, env)).pipe(
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
export default {
  scheduled(controller: ScheduledController, env: Env) {
    return Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          yield* tick(env);
          if (Math.floor(controller.scheduledTime / 60000) % 5 === 0) yield* reconcile(env);
        }),
      ),
    );
  },
  queue(batch: MessageBatch<unknown>, env: Env) {
    return Effect.runPromise(consume(batch, env));
  },
  fetch(request: Request, env: Env) {
    return Effect.runPromise(handleRequest(request, env));
  },
};

export class Agent extends AgentProtocol<Env> {
  fetch(request: Request) {
    return Effect.runPromise(handleRequest(request, this.env));
  }
  runWithTools(
    request: typeof AgentRequest.Encoded,
    callback: RpcStub<HostCallback>,
  ): Promise<typeof AgentReply.Encoded> {
    const bindings = this.env;
    return Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          yield* Effect.addFinalizer(() => Effect.sync(() => callback[Symbol.dispose]()));
          const input = yield* Schema.decodeUnknownEffect(AgentRequest, {
            onExcessProperty: "error",
          })(request);
          const capability = yield* authorize(bindings, input.token, input.sandboxId);
          const calls = { count: 0 };
          const host = Effect.fn("agent.hostCall")(function* (call: typeof HostCall.Type) {
            const now = yield* Clock.currentTimeMillis;
            if (now >= capability.expiresAt)
              return yield* new Fault({
                code: "UNAUTHORIZED",
                status: 401,
                message: "Capability expired",
              });
            if (!input.tools.includes(call.name))
              return yield* new Fault({
                code: "FORBIDDEN",
                status: 403,
                message: "Tool is not granted to this execution",
              });
            if (calls.count >= input.maxToolCalls)
              return yield* new Fault({
                code: "TOOL_LIMIT",
                status: 429,
                message: "Host tool budget exhausted",
              });
            yield* head(bindings, capability.sandboxId);
            calls.count += 1;
            const reply = yield* Effect.acquireUseRelease(
              Effect.tryPromise({
                try: async () => await callback(call),
                catch: (cause) => new HostFailure({ cause }),
              }),
              (value) => Schema.decodeUnknownEffect(HostReply)(value),
              (value) => Effect.sync(() => value[Symbol.dispose]()),
            );
            const encoded = yield* Schema.encodeEffect(Schema.fromJsonString(HostReply))(reply);
            if (Buffer.byteLength(encoded) > 1_048_576)
              return yield* new Fault({
                code: "EFBIG",
                status: 413,
                message: "Host response exceeds 1 MiB",
              });
            if (!reply.ok)
              return yield* new Fault({
                code: "HOST_TOOL_FAILED",
                status: 400,
                message: reply.message,
              });
            return reply.value;
          });
          const record = yield* run(
            bindings,
            capability,
            { op: "process.run", id: input.id, language: "typescript", source: input.source },
            host,
            input.timeoutMs,
          );
          return Schema.encodeSync(AgentReply)({ ok: true, record });
        }).pipe(
          Effect.catchTag("Fault", (failure) =>
            Effect.succeed(
              Schema.encodeSync(AgentReply)({
                ok: false,
                status: failure.status,
                error: failure.code,
                message: failure.message,
              }),
            ),
          ),
        ),
      ),
    );
  }
}
