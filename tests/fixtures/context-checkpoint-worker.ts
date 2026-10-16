import { Effect, Schema } from "effect";
import platformProxy from "@alchemy.run/cloudflare-runtime/core/platform-proxy/worker";
import { PLATFORM_PROXY_PREFIX } from "@alchemy.run/cloudflare-runtime/core/platform-proxy/PlatformProxyProtocol";
import wasm from "cirro:guest";
import revision from "../../dist/guest/revision.json";
import { createBindings } from "../../dist/guest/bindings";
import { ErrorResponse, Fault, HostCall, ScriptProgram, ToolStep } from "../../src/contracts";
import { StorageFailure } from "../../src/storage";
import type { Env } from "../../src/resources";
import {
  ContextCheckpointProof,
  ContextCheckpointRequest,
  ContextMemory,
} from "./context-checkpoint-contract";

const Step = Schema.Union([
  ToolStep,
  Schema.Struct({ kind: Schema.Literal("request"), action: Schema.fromJsonString(HostCall) }),
]);

const saveMemory = Effect.fn("contextFixture.saveMemory")(function* (
  objects: Env["OBJECTS"],
  memory: WebAssembly.Memory,
  handle: number,
) {
  const bytes = Uint8Array.from(new Uint8Array(memory.buffer));
  const digest = Buffer.from(
    yield* Effect.promise(() => crypto.subtle.digest("SHA-256", bytes)),
  ).toString("hex");
  const metadata = yield* Schema.decodeUnknownEffect(ContextMemory)({
    version: 1,
    runtime: revision.sha256,
    digest,
    memoryBytes: bytes.byteLength,
    handle,
  });
  const body = Schema.encodeSync(Schema.fromJsonString(ContextMemory))(metadata);
  const hash = Buffer.from(
    yield* Effect.promise(() => crypto.subtle.digest("SHA-256", new TextEncoder().encode(body))),
  ).toString("hex");
  yield* Effect.promise(() =>
    objects.put(`context-heap/${digest}.bin`, bytes, {
      onlyIf: { etagDoesNotMatch: "*" },
    }),
  );
  yield* Effect.promise(() =>
    objects.put(`context-heap/${hash}.json`, body, {
      onlyIf: { etagDoesNotMatch: "*" },
    }),
  );
  return hash;
});

export default {
  fetch(request: Parameters<typeof platformProxy.fetch>[0], env: Pick<Env, "OBJECTS">) {
    if (new URL(request.url).pathname.startsWith(`${PLATFORM_PROXY_PREFIX}/`))
      return platformProxy.fetch(request, env);
    return Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const input = yield* Schema.decodeUnknownEffect(
            Schema.fromJsonString(ContextCheckpointRequest),
          )(yield* Effect.promise(() => request.text()));
          if (input.op === "save-reused") {
            const bindings = createBindings();
            bindings.initSync({ module: wasm });
            const program = Schema.encodeSync(Schema.fromJsonString(ScriptProgram))(input.program);
            const previous = new bindings.Guest(program, 8_388_608, 1000, 4096);
            previous.free();
            const current = new bindings.Guest(program, 8_388_608, 1000, 4096);
            const parked = yield* Effect.try({
              try: () => current.park(),
              catch: (cause) => cause,
            }).pipe(Effect.result);
            if (parked._tag === "Success") {
              bindings.Guest.resume(parked.success).free();
              return yield* Effect.die("A reused native runtime permitted a context snapshot");
            }
            return {
              op: "isolation-denied" as const,
              message: yield* Schema.decodeUnknownEffect(Schema.String)(parked.failure),
            };
          }
          if (input.op === "save") {
            const bindings = createBindings();
            const native = bindings.initSync({ module: wasm });
            const retained = yield* Effect.acquireRelease(
              Effect.sync(() => ({
                guest: new bindings.Guest(
                  Schema.encodeSync(Schema.fromJsonString(ScriptProgram))(input.program),
                  8_388_608,
                  1000,
                  4096,
                ),
                released: false,
              })),
              (retained) =>
                Effect.sync(() => {
                  if (!retained.released) retained.guest.free();
                }),
            );
            const guest = retained.guest;
            const before = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Step))(
              guest.step(),
            );
            if (before.kind !== "request" || before.action.op !== "host.call") {
              return yield* Effect.die("Expected a native host callback");
            }
            retained.released = true;
            const handle = guest.park();
            const hash = yield* saveMemory(env.OBJECTS, native.memory, handle);
            return { op: "saved" as const, hash, request: before.action };
          }
          const stored = yield* Effect.promise(() =>
            env.OBJECTS.get(`context-heap/${input.hash}.json`),
          );
          if (stored === null || stored.size > 4096)
            return yield* new StorageFailure({ cause: "Missing context manifest" });
          const text = yield* Effect.promise(() => stored.text());
          const hash = Buffer.from(
            yield* Effect.promise(() =>
              crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)),
            ),
          ).toString("hex");
          if (hash !== input.hash)
            return yield* new StorageFailure({ cause: "Context manifest digest mismatch" });
          const metadata = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(ContextMemory))(
            text,
          );
          if (metadata.runtime !== revision.sha256)
            return yield* new Fault({
              code: "CHECKPOINT_RUNTIME_MISMATCH",
              status: 409,
              message: "Context uses another Rust runtime",
            });
          const blob = yield* Effect.promise(() =>
            env.OBJECTS.get(`context-heap/${metadata.digest}.bin`),
          );
          if (blob === null || blob.size !== metadata.memoryBytes)
            return yield* new StorageFailure({ cause: "Missing context heap" });
          const bytes = yield* Effect.promise(() => blob.arrayBuffer());
          const digest = Buffer.from(
            yield* Effect.promise(() => crypto.subtle.digest("SHA-256", bytes)),
          ).toString("hex");
          if (digest !== metadata.digest)
            return yield* new StorageFailure({ cause: "Context heap digest mismatch" });
          const bindings = createBindings();
          const native = bindings.initSync({ module: wasm });
          const additional = (metadata.memoryBytes - native.memory.buffer.byteLength) / 65_536;
          if (!Number.isInteger(additional) || additional < 0)
            return yield* new StorageFailure({ cause: "Invalid context memory layout" });
          if (additional > 0) native.memory.grow(additional);
          new Uint8Array(native.memory.buffer).set(new Uint8Array(bytes));
          const retained = yield* Effect.acquireRelease(
            Effect.sync(() => ({ guest: bindings.Guest.resume(metadata.handle), released: false })),
            (retained) =>
              Effect.sync(() => {
                if (!retained.released) retained.guest.free();
              }),
          );
          const guest = retained.guest;
          if (input.op === "continue") {
            guest.begin(
              Schema.encodeSync(Schema.fromJsonString(ScriptProgram))(input.program),
              1000,
            );
            const next = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Step))(
              guest.step(),
            );
            if (next.kind !== "done") return yield* Effect.die("Context reentry did not complete");
            retained.released = true;
            const handle = guest.park();
            const hash = yield* saveMemory(env.OBJECTS, native.memory, handle);
            return { op: "continued" as const, output: next.output, hash };
          }
          guest.respond(
            Schema.encodeSync(Schema.fromJsonString(Schema.Number))(input.reply),
            false,
          );
          const after = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Step))(
            guest.step(),
          );
          if (after.kind !== "done") return yield* Effect.die("Context did not resume its promise");
          if (input.op === "resume") return { op: "resumed" as const, output: after.output };
          guest.begin(Schema.encodeSync(Schema.fromJsonString(ScriptProgram))(input.program), 1000);
          const next = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Step))(guest.step());
          if (next.kind !== "done") return yield* Effect.die("Context reentry did not complete");
          retained.released = true;
          const handle = guest.park();
          const nextHash = yield* saveMemory(env.OBJECTS, native.memory, handle);
          return {
            op: "reentered" as const,
            previous: after.output,
            output: next.output,
            hash: nextHash,
          };
        }),
      ).pipe(
        Effect.map(
          (proof) =>
            new Response(Schema.encodeSync(Schema.fromJsonString(ContextCheckpointProof))(proof), {
              headers: { "content-type": "application/json" },
            }),
        ),
        Effect.catchTag("Fault", (fault) =>
          Effect.succeed(
            new Response(
              Schema.encodeSync(Schema.fromJsonString(ErrorResponse))({
                error: fault.code,
                message: fault.message,
              }),
              { status: fault.status },
            ),
          ),
        ),
        Effect.catchTag("StorageFailure", () =>
          Effect.succeed(
            new Response(
              Schema.encodeSync(Schema.fromJsonString(ErrorResponse))({
                error: "STORAGE_FAILURE",
                message: "Context checkpoint validation failed",
              }),
              { status: 500 },
            ),
          ),
        ),
      ),
    );
  },
};
