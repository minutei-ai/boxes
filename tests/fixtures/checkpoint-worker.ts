import { Effect, Schema } from "effect";
import platformProxy from "@alchemy.run/cloudflare-runtime/core/platform-proxy/worker";
import { PLATFORM_PROXY_PREFIX } from "@alchemy.run/cloudflare-runtime/core/platform-proxy/PlatformProxyProtocol";
import wasm from "cirro:wasi";
import { createBindings } from "../../dist/wasi/bindings";
import { saveHeap, restoreHeap } from "../../src/checkpoint";
import { WasmStep, SpawnStageResult } from "../../src/contracts";
import type { Env } from "../../src/resources";

import { CheckpointRequest, CheckpointProof } from "./checkpoint-contract";
export default {
  fetch(request: Parameters<typeof platformProxy.fetch>[0], env: Pick<Env, "OBJECTS">) {
    if (new URL(request.url).pathname.startsWith(`${PLATFORM_PROXY_PREFIX}/`))
      return platformProxy.fetch(request, env);
    return Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const text = yield* Effect.tryPromise(() => request.text());
          const input = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(CheckpointRequest))(
            text,
          );
          const proof = yield* Effect.gen(function* () {
            if (input.op === "save" || input.op === "save-family") {
              const bindings = createBindings();
              const exports = bindings.initSync({ module: wasm });
              const guest = new bindings.WasmGuest(
                Buffer.from(input.source, "base64"),
                '{"argv":[],"env":{}}',
                Buffer.alloc(0),
                8388608,
                100000000n,
                1048576,
              );
              const before = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(WasmStep))(
                guest.step(),
              );
              if (input.op === "save-family") {
                if (before.kind !== "spawn")
                  return yield* Effect.die("Family did not request spawn");
                for (const [index] of before.actions.entries()) {
                  const staged = Schema.decodeUnknownSync(Schema.fromJsonString(SpawnStageResult))(
                    guest.spawn_action(index),
                  );
                  if (staged.errno !== 0)
                    return yield* Effect.die("Family descriptor action failed");
                }
                const child = guest.spawn_child(
                  Buffer.from(input.child, "base64"),
                  '{"argv":[],"env":{}}',
                  "/",
                );
                if (child === undefined) return yield* Effect.die("Child failed to instantiate");
                const childBefore = Schema.decodeUnknownSync(Schema.fromJsonString(WasmStep))(
                  child.step(),
                );
                if (childBefore.kind !== "poll")
                  return yield* Effect.die("Child did not wait for pipe input");
                const parentBefore = Schema.decodeUnknownSync(Schema.fromJsonString(WasmStep))(
                  guest.step(),
                );
                if (parentBefore.kind !== "poll")
                  return yield* Effect.die("Parent did not wait for reply");
                const rootPid = guest.pid;
                const childPid = child.pid;
                const rootHandle = guest.park();
                const childHandle = child.park();
                const hash = yield* saveHeap(env.OBJECTS, "checkpoint-test", exports.memory, [
                  { pid: rootPid, handle: rootHandle },
                  { pid: childPid, handle: childHandle },
                ]);
                return { op: "saved" as const, hash, before: parentBefore };
              }
              const pid = guest.pid;
              const handle = guest.park();
              const hash = yield* saveHeap(env.OBJECTS, "checkpoint-test", exports.memory, [
                { pid, handle },
              ]);
              return { op: "saved" as const, hash, before };
            }
            const restored = yield* restoreHeap(env.OBJECTS, "checkpoint-test", input.hash);
            const handle = restored.handles[0];
            if (handle === undefined) return yield* Effect.die("Missing test checkpoint handle");
            const guest = yield* Effect.acquireRelease(
              Effect.sync(() => restored.bindings.WasmGuest.resume(handle.handle)),
              (guest) => Effect.sync(() => guest.free()),
            );
            if (restored.handles.length === 2) {
              const item = restored.handles[1];
              if (item === undefined) return yield* Effect.die("Missing child handle");
              const child = restored.bindings.WasmGuest.resume(item.handle);
              if (!child.io_ready())
                return yield* Effect.die("Restored pipe lost its buffered input");
              child.respond(0, Buffer.alloc(0), "/", false, 0n, Buffer.alloc(0));
              const terminal = Schema.decodeUnknownSync(Schema.fromJsonString(WasmStep))(
                child.step(),
              );
              if (terminal.kind !== "done" || terminal.output.exitCode !== 7)
                return yield* Effect.die("Restored child did not exit correctly");
              child.finish_child(false);
              child.free();
              if (!guest.io_ready())
                return yield* Effect.die("Restored parent lost reply readiness");
              guest.respond(
                0,
                Buffer.from(Schema.encodeSync(Schema.fromJsonString(Schema.Array(Schema.Int)))([])),
                "/",
                false,
                0n,
                Buffer.alloc(0),
              );
            }
            const after = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(WasmStep))(
              guest.step(),
            );
            if (after.kind === "done")
              return { op: "resumed" as const, after, terminal: after, steps: 1 };
            const steps = { count: 0 };
            while (steps.count < 1000) {
              const step = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(WasmStep))(
                guest.step(),
              );
              steps.count += 1;
              if (step.kind === "done")
                return { op: "resumed" as const, after, terminal: step, steps: steps.count };
            }
            return yield* Effect.die("Checkpoint test did not terminate");
          });
          return new Response(Schema.encodeSync(Schema.fromJsonString(CheckpointProof))(proof), {
            headers: { "content-type": "application/json" },
          });
        }),
      ).pipe(
        Effect.catchTag("StorageFailure", (failure) =>
          Effect.sync(() => new Response(String(failure.cause), { status: 500 })),
        ),
        Effect.catch((cause) => Effect.sync(() => new Response(String(cause), { status: 500 }))),
      ),
    );
  },
};
