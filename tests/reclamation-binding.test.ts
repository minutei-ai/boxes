import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { Effect, Redacted, Schema } from "effect";
import { FetchHttpClient } from "effect/http";
import { PlatformProxy, Runtime } from "@alchemy.run/cloudflare-runtime/core";
import { Json, Service } from "@alchemy.run/cloudflare-runtime/core/bindings";
import { make } from "@minutei-ai/boxes";
import { runtime } from "../tooling/worker-test";

const Endpoints = Schema.Struct({ URLS: Schema.Array(Schema.String) });
test(
  "public SDK reclamation crosses native bindings and resumes under renewed management authority",
  () =>
    Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const directory = yield* Effect.acquireRelease(
            Effect.promise(() => mkdtemp("/tmp/boxes-reclaim-binding-")),
            (path) => Effect.promise(() => rm(path, { recursive: true, force: true })),
          );
          const worker = yield* Effect.acquireRelease(
            Effect.sync(() => runtime(join(directory, "backend"))),
            (worker) => Effect.promise(() => worker.dispose()),
          );
          const url = (yield* Effect.promise(() => worker.ready)).toString();
          const built = yield* Effect.promise(() =>
            Bun.build({
              entrypoints: ["tests/fixtures/reclamation-binding-worker.ts"],
              target: "browser",
              format: "esm",
              external: ["cloudflare:workers"],
            }),
          );
          const module = built.outputs[0];
          if (!built.success || module === undefined || built.outputs.length !== 1)
            return yield* Effect.die({
              message: "Reclamation consumer failed to build",
              logs: built.logs,
            });
          const content = yield* Effect.promise(() => module.text());
          const bindings = [
            Effect.gen(function* () {
              const native = yield* Runtime;
              const endpoints = yield* Effect.forEach(["initial", "replacement"], (phase) =>
                native.start({
                  name: `${worker.name}-reclaim-${phase}`,
                  compatibilityDate: "2026-10-06",
                  compatibilityFlags: [],
                  bindings: [Service.local({ binding: "BOXES", scriptName: worker.name })],
                  modules: [{ name: "index.js", type: "ESModule", content }],
                }),
              );
              return yield* Json.local(
                "URLS",
                endpoints.map((endpoint) => endpoint.href),
              );
            }).pipe(Effect.orDie),
          ];
          const proxy = yield* Effect.acquireRelease(
            Effect.promise(() =>
              PlatformProxy.getPlatformProxy<typeof Endpoints.Type, typeof bindings>({
                name: `${worker.name}-reclaim-proxy`,
                bindings,
                persist: { directory: join(directory, "consumer") },
              }),
            ),
            (proxy) => Effect.promise(() => proxy.dispose()),
          );
          const id = "binding-reclaim";
          const admin = yield* make({ url, token: Redacted.make("cirro-local-test-credential") });
          yield* admin.create({
            id,
            policy: {
              networkHosts: [],
              interruptBudget: 1000,
              memoryBytes: 8388608,
              maxOutputBytes: 1048576,
            },
          });
          const grant = yield* admin.mintCapability(id, {
            permissions: ["read", "write", "execute", "manage"],
            expiresInSeconds: 600,
          });
          const manager = yield* make({ url, token: Redacted.make(grant.token) });
          yield* manager.action(id, {
            op: "filesystem.writeFile",
            path: "/proof",
            content: "binding",
            encoding: "utf8",
          });
          yield* manager.action(id, {
            op: "process.run",
            id: "finished",
            language: "javascript",
            source: "export default () => 42;",
          });
          const owner = yield* admin.mintCapability(id, {
            permissions: ["manage"],
            expiresInSeconds: 600,
          });
          const initial = yield* make({
            url: proxy.env.URLS[0],
            token: Redacted.make(owner.token),
          });
          expect(
            yield* initial.action(id, { op: "vm.reclaim", limit: 1 }).pipe(Effect.flip),
          ).toMatchObject({ _tag: "BoxesError", status: 409 });
          const read = yield* admin.mintCapability(id, {
            permissions: ["read"],
            expiresInSeconds: 600,
          });
          const reader = yield* make({ url: proxy.env.URLS[0], token: Redacted.make(read.token) });
          expect(
            yield* reader.action(id, { op: "vm.reclaim", limit: 1 }).pipe(Effect.flip),
          ).toMatchObject({ _tag: "BoxesError", status: 403 });
          yield* manager.action(id, { op: "vm.dispose" });
          expect(yield* initial.action(id, { op: "vm.reclaim", limit: 1 })).toMatchObject({
            status: "pending",
            removed: 1,
            phase: "processes",
          });
          const renewed = yield* admin.mintCapability(id, {
            permissions: ["manage"],
            expiresInSeconds: 600,
          });
          const replacement = yield* make({
            url: proxy.env.URLS[1],
            token: Redacted.make(renewed.token),
          });
          const progress = [];
          for (const _ of Array.from({ length: 16 })) {
            const step = yield* replacement.action(id, { op: "vm.reclaim", limit: 1000 });
            progress.push(step);
            if (step.status === "complete") break;
          }
          expect(progress.at(-1)?.status).toBe("complete");
          const objects = yield* Effect.promise(() => worker.objects);
          expect(
            (yield* Effect.promise(() => objects.list({ prefix: `sandboxes/${id}/` }))).objects.map(
              (object) => object.key,
            ),
          ).toEqual([`sandboxes/${id}/head.json`]);
          expect(
            (yield* Effect.promise(() => objects.list({ prefix: `processes/${id}/` }))).objects,
          ).toEqual([]);
        }),
      ).pipe(Effect.provide(FetchHttpClient.layer)),
    ),
  20000,
);
