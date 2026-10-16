import { downloadPublished } from "./fixtures/published-package";
import { publishedPackages, publishedInterpreterCases } from "./fixtures/published-software";
import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { Effect, Fiber, Redacted, Schedule, Schema } from "effect";
import { FetchHttpClient } from "effect/http";
import { PlatformProxy, Runtime } from "@alchemy.run/cloudflare-runtime/core";
import { Json, Service } from "@alchemy.run/cloudflare-runtime/core/bindings";
import { make } from "../src/sdk";
import { runtime } from "../tooling/worker-test";
import {
  RemoteBindingInput,
  VerifiedRemoteBindingProof,
  remoteRpcTimeoutMs,
  remoteDeadlinePath,
} from "./fixtures/remote-binding-contracts";
import {
  PersistentBindingInput,
  VerifiedPersistentBindingProof,
} from "./fixtures/remote-persistent-binding";

const Endpoints = Schema.Struct({ URLS: Schema.Array(Schema.String) });
test(
  "native binding consumers reconnect persistent Code Mode with scoped authority and fresh callbacks",
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
              interruptBudget: 100000,
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
          const software = publishedPackages.find((entry) => entry.name === "sh");
          if (software === undefined) return yield* Effect.die("Missing pinned shell package");
          const packageBytes = yield* downloadPublished(software);
          yield* manager.action(id, {
            op: "filesystem.writeFile",
            path: "/tmp/binding-sh.aospkg",
            content: packageBytes.toString("base64"),
            encoding: "base64",
          });
          yield* manager.action(id, {
            op: "software.install",
            source: { path: "/tmp/binding-sh.aospkg", digest: `sha256:${software.digest}` },
          });
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
              const endpoints = yield* Effect.forEach(["initial", "replacement"], (phase) =>
                native.start({
                  name: `${worker.name}-proof-${phase}`,
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
                name: `${worker.name}-proxy-proof`,
                bindings,
                persist: { directory: join(directory, "consumer") },
              }),
            ),
            (value) => Effect.promise(() => value.dispose()),
          );
          const pending = yield* Effect.gen(function* () {
            const response = yield* Effect.promise(() =>
              fetch(proxy.env.URLS[0], {
                method: "POST",
                body: Schema.encodeSync(Schema.fromJsonString(RemoteBindingInput))({
                  sandboxId: id,
                  token: grant.token,
                }),
              }),
            );
            expect(response.status).toBe(200);
            const body = yield* Effect.promise(() => response.text());
            return yield* Schema.decodeUnknownEffect(
              Schema.fromJsonString(VerifiedRemoteBindingProof),
            )(body);
          }).pipe(Effect.forkChild);
          const active = yield* manager.action(id, { op: "process.get", id: "rpc-callback" }).pipe(
            Effect.retry({
              times: 40,
              schedule: Schedule.spaced("10 millis"),
              while: (failure) => failure._tag === "BoxesError" && failure.status === 404,
            }),
          );
          const recovery = yield* manager.action(id, {
            op: "process.recovery.status",
            id: "rpc-callback",
          });
          expect(active.status).toBe("running");
          expect(recovery).toMatchObject({
            state: "running",
            checkpoints: 0,
            resumable: false,
            deadlineAt: active.startedAt + remoteRpcTimeoutMs,
          });
          yield* manager.action(id, {
            op: "filesystem.writeFile",
            path: remoteDeadlinePath,
            content: "observed",
            encoding: "utf8",
          });
          const proof = yield* Fiber.join(pending);
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
            ...publishedInterpreterCases.map((probe) => probe.id).toSorted(),
          ]);
          const readonly = yield* admin.mintCapability(id, {
            permissions: ["read", "execute"],
            expiresInSeconds: 600,
          });
          for (const [phase, endpoint, token] of [
            ["create", proxy.env.URLS[0], grant.token],
            ["resume", proxy.env.URLS[1], readonly.token],
          ] as const) {
            const response = yield* Effect.promise(() =>
              fetch(new URL("/persistent", endpoint), {
                method: "POST",
                body: Schema.encodeSync(Schema.fromJsonString(PersistentBindingInput))({
                  phase,
                  sandboxId: id,
                  token,
                }),
              }),
            );
            expect(response.status).toBe(200);
            const proof = yield* Schema.decodeUnknownEffect(
              Schema.fromJsonString(VerifiedPersistentBindingProof),
            )(yield* Effect.promise(() => response.text()));
            expect(proof.phase).toBe(phase);
          }
          const retained = yield* manager.action(id, {
            op: "filesystem.readFile",
            path: "/persistent.txt",
          });
          expect(Buffer.from(retained.content, retained.encoding).toString()).toBe(
            "persistent native binding",
          );
          const previous = yield* manager.action(id, { op: "process.get", id: "rpc-callback" });
          expect(previous.status).toBe("exited");
        }),
      ).pipe(Effect.provide(FetchHttpClient.layer)),
    ),
  20000,
);
