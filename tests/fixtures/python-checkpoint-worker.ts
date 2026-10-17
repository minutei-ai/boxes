import { Effect, Schema } from "effect";
import platformProxy from "@alchemy.run/cloudflare-runtime/core/platform-proxy/worker";
import { PLATFORM_PROXY_PREFIX } from "@alchemy.run/cloudflare-runtime/core/platform-proxy/PlatformProxyProtocol";
import wasm from "cirro:python";
import revision from "../../dist/python/revision.json";
import { createBindings } from "../../dist/python/bindings";
import { Environment, HostCall, ToolStep } from "../../src/contracts";
import { restoreMemoryPages, saveMemoryPages } from "../../src/memory";
import type { Env } from "../../src/resources";
import {
  PythonCheckpointProof,
  PythonCheckpointRequest,
  PythonHeap,
} from "./python-checkpoint-contract";

const Step = Schema.Union([
  ToolStep,
  Schema.Struct({ kind: Schema.Literal("request"), action: Schema.fromJsonString(HostCall) }),
]);

export default {
  fetch(request: Parameters<typeof platformProxy.fetch>[0], env: Pick<Env, "OBJECTS">) {
    if (new URL(request.url).pathname.startsWith(`${PLATFORM_PROXY_PREFIX}/`))
      return platformProxy.fetch(request, env);
    return Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const input = yield* Schema.decodeUnknownEffect(
            Schema.fromJsonString(PythonCheckpointRequest),
          )(yield* Effect.promise(() => request.text()));
          const observed = { reads: 0 };
          const objects = new Proxy(env.OBJECTS, {
            get(target, property) {
              if (property === "get")
                return (...args: Parameters<Env["OBJECTS"]["get"]>) => {
                  if (args[0].startsWith("sandboxes/python-heap-proof/checkpoint-packs/"))
                    observed.reads += 1;
                  return target.get(...args);
                };
              const value = Reflect.get(target, property, target);
              if (typeof value === "function") return value.bind(target);
              return value;
            },
          });
          const bindings = createBindings();
          const state = bindings.initSync({ module: wasm });
          state.__cirro_limits(
            100_000_000n,
            Math.floor(state.memory.buffer.byteLength / 65536) + 512,
          );
          const prior = yield* Effect.gen(function* () {
            if (input.hash === null) return null;
            const object = yield* Effect.promise(() =>
              env.OBJECTS.get(`python-heap/${input.hash}.json`),
            );
            if (object === null || object.size > 65536)
              return yield* Effect.die("Missing Python heap");
            const body = yield* Effect.promise(() => object.arrayBuffer());
            const hash = Buffer.from(
              yield* Effect.promise(() => crypto.subtle.digest("SHA-256", body)),
            ).toString("hex");
            if (hash !== input.hash) return yield* Effect.die("Python heap digest mismatch");
            const metadata = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(PythonHeap))(
              new TextDecoder().decode(body),
            );
            if (metadata.runtime !== revision.sha256)
              return yield* Effect.die("Python runtime mismatch");
            yield* restoreMemoryPages(objects, "python-heap-proof", state.memory, metadata);
            return metadata;
          });
          const ownership = { consumed: false };
          const guest = yield* Effect.acquireRelease(
            Effect.sync(() => {
              if (prior === null)
                return new bindings.PythonGuest(
                  input.program.source,
                  input.program.filePath,
                  input.program.mode === "evaluate",
                  4096,
                  Schema.encodeSync(Schema.fromJsonString(Environment))(input.program.env),
                );
              const restored = bindings.PythonGuest.resume(prior.handle);
              restored.begin(
                input.program.source,
                input.program.filePath,
                input.program.mode === "evaluate",
                Schema.encodeSync(Schema.fromJsonString(Environment))(input.program.env),
              );
              return restored;
            }),
            (guest) =>
              Effect.sync(() => {
                if (!ownership.consumed) guest.free();
              }),
          );
          const duplicateHandleDenied = yield* Effect.gen(function* () {
            if (prior === null) return false;
            const duplicate = yield* Effect.try({
              try: () => bindings.PythonGuest.resume(prior.handle),
              catch: (cause) => cause,
            }).pipe(Effect.result);
            if (duplicate._tag === "Success")
              return yield* Effect.die("Python handle was consumed twice");
            return true;
          });
          const initial = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Step))(
            guest.step(),
          );
          const result = yield* Effect.gen(function* () {
            if (initial.kind === "done") return { step: initial, nonquiescentDenied: false };
            const busy = yield* Effect.try({
              try: () => guest.begin("0", "/invalid.py", true, "{}"),
              catch: (cause) => cause,
            }).pipe(Effect.result);
            if (busy._tag === "Success")
              return yield* Effect.die("Pending Python execution was overwritten");
            guest.respond(
              Schema.encodeSync(Schema.fromJsonString(Schema.Json))(input.reply),
              false,
            );
            const step = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Step))(
              guest.step(),
            );
            return { step, nonquiescentDenied: true };
          });
          if (result.step.kind !== "done" || !guest.quiescent())
            return yield* Effect.die("Python context did not settle");
          ownership.consumed = true;
          const handle = guest.park();
          const saved = yield* saveMemoryPages(
            env.OBJECTS,
            "python-heap-proof",
            state.memory,
            prior?.pages,
          );
          const metadata = {
            runtime: revision.sha256,
            codec: saved.codec,
            memoryBytes: saved.memoryBytes,
            pages: saved.pages,
            handle,
          };
          const body = Schema.encodeSync(Schema.fromJsonString(PythonHeap))(metadata);
          const hash = Buffer.from(
            yield* Effect.promise(() =>
              crypto.subtle.digest("SHA-256", new TextEncoder().encode(body)),
            ),
          ).toString("hex");
          yield* Effect.promise(() =>
            env.OBJECTS.put(`python-heap/${hash}.json`, body, {
              onlyIf: { etagDoesNotMatch: "*" },
            }),
          );
          return new Response(
            Schema.encodeSync(Schema.fromJsonString(PythonCheckpointProof))({
              hash,
              output: result.step.output,
              nonquiescentDenied: result.nonquiescentDenied,
              duplicateHandleDenied,
              puts: saved.puts,
              reads: observed.reads,
              memoryBytes: saved.memoryBytes,
              uniquePages: new Set(saved.pages).size,
              packs: saved.packs,
            }),
            { headers: { "content-type": "application/json" } },
          );
        }),
      ),
    );
  },
};
