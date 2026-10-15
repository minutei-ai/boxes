import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { Effect, Redacted, Schema } from "effect";
import { FetchHttpClient } from "effect/http";
import { PlatformProxy, Runtime } from "@alchemy.run/cloudflare-runtime/core";
import { Json, Service } from "@alchemy.run/cloudflare-runtime/core/bindings";
import { make } from "../src/sdk";
import { runtime } from "../tooling/worker-test";
import { RemoteBindingInput, VerifiedRemoteBindingProof } from "./fixtures/remote-binding-worker";

const Endpoints = Schema.Struct({ URL: Schema.String });
test(
  "binding consumer retains callbacks and void values with bounded authority and fresh globals",
  () =>
    Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const directory = yield* Effect.acquireRelease(
            Effect.promise(() => mkdtemp("/tmp/boxes-binding-consumer-")),
            (path) => Effect.promise(() => rm(path, { recursive: true, force: true })),
          );
          const worker = yield* Effect.acquireRelease(
            Effect.sync(() => runtime(join(directory, "boxes"), { controlled: false })),
            (worker) => Effect.promise(() => worker.dispose()),
          );
          const url = (yield* Effect.promise(() => worker.ready)).toString();
          const admin = yield* make({ url, token: Redacted.make("cirro-local-test-credential") });
          const id = "binding-consumer";
          yield* admin.create({
            id,
            policy: {
              networkHosts: [],
              interruptBudget: 10000,
              memoryBytes: 8388608,
              maxOutputBytes: 1048576,
            },
          });
          const management = yield* admin.mintCapability(id, {
            permissions: ["read", "write", "execute", "manage"],
            expiresInSeconds: 600,
          });
          const manager = yield* Effect.acquireRelease(
            make({ url, token: Redacted.make(management.token) }),
            (client) => client.action(id, { op: "vm.dispose" }).pipe(Effect.orDie),
          );
          const grant = yield* admin.mintCapability(id, {
            permissions: ["read", "write", "execute"],
            expiresInSeconds: 600,
          });
          const content = yield* Effect.promise(() =>
            Bun.file("dist/remote-binding-worker/index.js").text(),
          );
          const bindings = [
            Effect.gen(function* () {
              const native = yield* Runtime;
              const endpoint = yield* native.start({
                name: `${worker.name}-proof`,
                compatibilityDate: "2026-10-06",
                compatibilityFlags: ["nodejs_compat"],
                bindings: [
                  Service.local({ binding: "BOXES", scriptName: worker.name }),
                  Service.local({
                    binding: "BOXES_AGENT",
                    scriptName: worker.name,
                    entrypoint: "Agent",
                  }),
                ],
                modules: [{ name: "index.js", type: "ESModule", content }],
              });
              return yield* Json.local("URL", endpoint.href);
            }).pipe(Effect.orDie),
          ];
          const proxy = yield* Effect.acquireRelease(
            Effect.promise(() =>
              PlatformProxy.getPlatformProxy<typeof Endpoints.Type, typeof bindings>({
                name: `${worker.name}-proxy-proof`,
                bindings,
                persist: { directory: join(directory, "consumer") },
              }),
            ),
            (value) => Effect.promise(() => value.dispose()),
          );
          const response = yield* Effect.promise(() =>
            fetch(proxy.env.URL, {
              method: "POST",
              body: Schema.encodeSync(Schema.fromJsonString(RemoteBindingInput))({
                sandboxId: id,
                token: grant.token,
              }),
            }),
          );
          expect(response.status).toBe(200);
          const body = yield* Effect.promise(() => response.text());
          const proof = yield* Schema.decodeUnknownEffect(
            Schema.fromJsonString(VerifiedRemoteBindingProof),
          )(body);
          const file = yield* manager.action(id, {
            op: "filesystem.readFile",
            path: "/binding.txt",
          });
          expect(file).toEqual(proof.file);
          const processes = yield* manager.action(id, {
            op: "process.list",
            limit: 10,
            cursor: null,
          });
          expect(processes.items.map((run) => run.id).toSorted()).toEqual([
            "rpc-callback",
            "rpc-void",
          ]);
        }),
      ).pipe(Effect.provide(FetchHttpClient.layer)),
    ),
  20000,
);
