import { Effect, Schema } from "effect";
import platformProxy from "@alchemy.run/cloudflare-runtime/core/platform-proxy/worker";
import { PLATFORM_PROXY_PREFIX } from "@alchemy.run/cloudflare-runtime/core/platform-proxy/PlatformProxyProtocol";
import wasm from "cirro:guest";
import revision from "../../dist/guest/revision.json";
import { createBindings } from "../../dist/guest/bindings";
import { ErrorResponse, Fault, HostCall, ScriptProgram, ToolStep } from "../../src/contracts";
import { StorageFailure } from "../../src/storage";
import { saveMemoryPages, restoreMemoryPages } from "../../src/memory";
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
  previous: typeof ContextMemory.Type.pages = [],
) {
  const observed = { writes: 0 };
  const traced = new Proxy(objects, {
    get(target, property) {
      if (property === "put")
        return (...args: Parameters<Env["OBJECTS"]["put"]>) => {
          if (args[0].startsWith("sandboxes/context-heap-proof/checkpoint-pages/"))
            observed.writes += 1;
          return target.put(...args);
        };
      const value = Reflect.get(target, property, target);
      if (typeof value === "function") return value.bind(target);
      return value;
    },
  });
  const saved = yield* saveMemoryPages(traced, "context-heap-proof", memory, previous);
  if (observed.writes !== saved.pageWrites)
    return yield* Effect.die("Native R2 writes differ from page accounting");
  const metadata = yield* Schema.decodeUnknownEffect(ContextMemory)({
    version: 2,
    runtime: revision.sha256,
    memoryBytes: saved.memoryBytes,
    pages: saved.pages,
    handle,
  });
  const body = Schema.encodeSync(Schema.fromJsonString(ContextMemory))(metadata);
  const hash = Buffer.from(
    yield* Effect.promise(() => crypto.subtle.digest("SHA-256", new TextEncoder().encode(body))),
  ).toString("hex");
  yield* Effect.promise(() =>
    objects.put(`context-heap/${hash}.json`, body, {
      onlyIf: { etagDoesNotMatch: "*" },
    }),
  );
  return {
    hash,
    storage: {
      pages: saved.pages.length,
      uniquePages: new Set(saved.pages).size,
      pageWrites: observed.writes,
    },
  };
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
          if (input.op === "pages") {
            const memory = new WebAssembly.Memory({ initial: 3, maximum: 4 });
            const first = yield* saveMemoryPages(env.OBJECTS, "memory-pages-proof", memory);
            const unchanged = yield* saveMemoryPages(
              env.OBJECTS,
              "memory-pages-proof",
              memory,
              first.pages,
            );
            new Uint8Array(memory.buffer)[131_072] = 42;
            const changed = yield* saveMemoryPages(
              env.OBJECTS,
              "memory-pages-proof",
              memory,
              unchanged.pages,
            );
            const restored = new WebAssembly.Memory({ initial: 1, maximum: 4 });
            yield* restoreMemoryPages(env.OBJECTS, "memory-pages-proof", restored, changed);
            const rejectedLayouts = yield* Effect.forEach(
              [
                { ...changed, memoryBytes: changed.memoryBytes + 1 },
                { ...changed, pages: changed.pages.slice(1) },
                { ...changed, memoryBytes: 0, pages: [] },
                { ...changed, memoryBytes: 67_174_400 },
              ],
              (snapshot) =>
                restoreMemoryPages(env.OBJECTS, "memory-pages-proof", restored, snapshot).pipe(
                  Effect.result,
                  Effect.flatMap((result) => {
                    if (result._tag === "Success")
                      return Effect.die("Invalid memory layout was restored");
                    return Schema.decodeUnknownEffect(Schema.String)(result.failure.cause);
                  }),
                ),
            );
            const inventory = yield* Effect.promise(() =>
              env.OBJECTS.list({
                prefix: "sandboxes/memory-pages-proof/checkpoint-pages/",
                limit: 1000,
              }),
            );
            if (inventory.truncated) return yield* Effect.die("Incomplete page inventory");
            return {
              op: "pages" as const,
              first: {
                pages: first.pages.length,
                uniquePages: new Set(first.pages).size,
                pageWrites: first.pageWrites,
              },
              unchanged: {
                pages: unchanged.pages.length,
                uniquePages: new Set(unchanged.pages).size,
                pageWrites: unchanged.pageWrites,
              },
              changed: {
                pages: changed.pages.length,
                uniquePages: new Set(changed.pages).size,
                pageWrites: changed.pageWrites,
              },
              restoredBytes: [0, 65_536, 131_072].map(
                (offset) => new Uint8Array(restored.buffer)[offset],
              ),
              storedPages: inventory.objects.length,
              rejectedLayouts,
            };
          }
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
            const saved = yield* saveMemory(env.OBJECTS, native.memory, handle);
            return { op: "saved" as const, ...saved, request: before.action };
          }
          const stored = yield* Effect.promise(() =>
            env.OBJECTS.get(`context-heap/${input.hash}.json`),
          );
          if (stored === null || stored.size > 131_072)
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
          const bindings = createBindings();
          const native = bindings.initSync({ module: wasm });
          yield* restoreMemoryPages(env.OBJECTS, "context-heap-proof", native.memory, metadata);
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
            const saved = yield* saveMemory(env.OBJECTS, native.memory, handle, metadata.pages);
            return { op: "continued" as const, output: next.output, ...saved };
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
          const saved = yield* saveMemory(env.OBJECTS, native.memory, handle, metadata.pages);
          return {
            op: "reentered" as const,
            previous: after.output,
            output: next.output,
            ...saved,
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
