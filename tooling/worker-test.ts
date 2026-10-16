import { Clock, Effect, Match, Schema } from "effect";
import { Runtime, PlatformProxy, type QueueConsumer } from "@alchemy.run/cloudflare-runtime/core";
import {
  R2Bucket,
  Text,
  Json,
  Queue,
  Service,
} from "@alchemy.run/cloudflare-runtime/core/bindings";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PluginContext } from "@alchemy.run/cloudflare-runtime/core";
import { RegistryProxy } from "@alchemy.run/cloudflare-runtime/core/registry/RegistryProxy";
import { connect } from "@alchemy.run/cloudflare-runtime/core/platform-proxy/connect";
import { BINDING_PLATFORM_PROXY_TOKEN } from "@alchemy.run/cloudflare-runtime/core/platform-proxy/PlatformProxyProtocol";
import * as Plugin from "@alchemy.run/cloudflare-runtime/core/Plugin";
import type { Env } from "../src/resources";
import { Digest } from "../src/contracts";
import type { Control } from "../tests/fixtures/clock-worker";

class NetworkOrigin extends Plugin.Service<NetworkOrigin>()(
  "cloudflare-runtime/plugin/BoxesOrigin",
) {}
const Endpoints = Schema.Struct({
  app: Schema.String,
  origin: Schema.UndefinedOr(Schema.String),
  binding: Schema.UndefinedOr(Schema.String),
});
type TestEnv = { ENDPOINTS: typeof Endpoints.Type; CONTROL: Fetcher<Control>; BOXES: Fetcher };
const Options = Schema.Struct({
  binding: Schema.optionalKey(Schema.Boolean),
  origin: Schema.optionalKey(Schema.Struct({ delay: Schema.Int, body: Schema.String })),
  advance: Schema.optionalKey(Schema.Int),
  advanceAfterOutput: Schema.optionalKey(Schema.String.check(Schema.isMinLength(1))),
  clockStart: Schema.optionalKey(Schema.Int),
  consume: Schema.optionalKey(Schema.Boolean),
  controlled: Schema.optionalKey(Schema.Boolean),
  artifact: Schema.optionalKey(
    Schema.Literals(["clock-worker", "checkpoint-worker", "context-checkpoint-worker"]),
  ),
  softwareBase: Schema.optionalKey(Digest),
});
export const runtime = (persist: string, options: typeof Options.Type = {}) => {
  const advance = options.advance ?? 0;
  const name = `boxes-test-${crypto.randomUUID()}`;
  const proxyToken = crypto.randomUUID();
  const consumers: QueueConsumer[] = [
    {
      queueName: name,
      maxBatchSize: 1,
      maxBatchTimeout: 0,
      maxRetries: 100,
    },
  ];
  const producer = { binding: "EVENTS", queueName: name, deliveryDelay: 86400 };
  if (options.consume === true) producer.deliveryDelay = 0;
  const start = options.clockStart ?? Effect.runSync(Clock.currentTimeMillis);
  const workerBindings = [
    R2Bucket.local({ binding: "OBJECTS", id: "boxes-test" }),
    Text.local(BINDING_PLATFORM_PROXY_TOKEN, proxyToken),
    Text.local("API_KEY", "cirro-local-test-credential"),
    Json.local("SOFTWARE_BASE", options.softwareBase ?? null),
    Json.local("CLOCK_START", start),
    Json.local("CLOCK_ADVANCE", advance),
    Json.local("CLOCK_ADVANCE_AFTER_OUTPUT", options.advanceAfterOutput ?? null),
    Json.local("CLOCK_CONTROLLED", options.controlled ?? true),
    Queue.local(producer),
    Service.self("SELF"),
  ];
  const artifact = options.artifact ?? "clock-worker";
  const engines = Match.value(artifact).pipe(
    Match.when("clock-worker", () => ["kernel", "wasi", "guest", "compiler", "python"]),
    Match.when("checkpoint-worker", () => ["kernel", "wasi"]),
    Match.when("context-checkpoint-worker", () => ["guest"]),
    Match.exhaustive,
  );
  const modules = [
    {
      name: "index.js",
      type: "ESModule" as const,
      content: readFileSync(join(import.meta.dir, `../dist/${artifact}/index.js`), "utf8"),
    },
    ...engines.map((module) => ({
      name: `cirro_${module}_bg.wasm`,
      type: "Wasm" as const,
      content: readFileSync(join(import.meta.dir, `../dist/${artifact}/cirro_${module}_bg.wasm`)),
    })),
  ];
  const bindings = [
    Effect.gen(function* () {
      const workerRuntime = yield* Runtime;
      const originName = `${name}-origin`;
      const origin = yield* Effect.gen(function* () {
        if (options.origin === undefined) return undefined;
        return yield* workerRuntime
          .start({
            name: originName,
            compatibilityDate: "2026-10-06",
            compatibilityFlags: [],
            bindings: [Json.local("OPTIONS", options.origin)],
            modules: [
              {
                name: "index.js",
                type: "ESModule",
                content: readFileSync(
                  join(import.meta.dir, "../dist/origin-worker/index.js"),
                  "utf8",
                ),
              },
            ],
          })
          .pipe(Effect.orDie);
      });
      const outbound = Effect.gen(function* () {
        if (options.origin === undefined) return {};
        const context = yield* PluginContext;
        const proxy = yield* context.get(RegistryProxy);
        const origin = yield* proxy.api.subscribe({ kind: "worker", scriptName: originName });
        return { userWorker: { globalOutbound: origin } };
      });
      const url = yield* workerRuntime
        .start({
          name,
          compatibilityDate: "2026-10-06",
          compatibilityFlags: [
            "nodejs_compat",
            "enable_request_signal",
            "experimental",
            "service_binding_extra_handlers",
          ],
          bindings: workerBindings,
          modules,
          queueConsumers: consumers,
        })
        .pipe(Effect.provideService(NetworkOrigin, outbound), Effect.orDie);
      const binding = yield* Effect.gen(function* () {
        if (options.binding !== true) return undefined;
        return yield* workerRuntime
          .start({
            name: `${name}-sdk`,
            compatibilityDate: "2026-10-06",
            compatibilityFlags: ["nodejs_compat", "enable_request_signal"],
            bindings: [
              Service.local({ binding: "BOXES", scriptName: name }),
              Service.local({ binding: "BOXES_AGENT", scriptName: name, entrypoint: "Agent" }),
              Text.local("TOKEN", "cirro-local-test-credential"),
            ],
            modules: [
              {
                name: "index.js",
                type: "ESModule",
                content: readFileSync(
                  join(import.meta.dir, "../dist/sdk-binding-worker/index.js"),
                  "utf8",
                ),
              },
            ],
          })
          .pipe(Effect.orDie);
      });
      return yield* Json.local("ENDPOINTS", {
        app: url.href,
        origin: origin?.href,
        binding: binding?.href,
      });
    }),
    Service.local({ binding: "CONTROL", scriptName: name, entrypoint: "Control" }),
    Service.local({ binding: "BOXES", scriptName: name }),
  ];
  const ready = PlatformProxy.getPlatformProxy<TestEnv, typeof bindings>({
    name: `${name}-proxy`,
    bindings,
    persist: { directory: persist },
    compatibilityFlags: ["experimental", "service_binding_extra_handlers"],
  });
  return {
    name,
    time: start + advance,
    ready: ready.then((value) => new URL(value.env.ENDPOINTS.app)),
    origin: () =>
      ready.then((value) => {
        if (value.env.ENDPOINTS.origin === undefined)
          return Promise.reject(new Error("Network fixture requires an origin"));
        return new URL(value.env.ENDPOINTS.origin);
      }),
    binding: () =>
      ready.then((value) => {
        if (value.env.ENDPOINTS.binding === undefined)
          return Promise.reject(new Error("SDK fixture requires binding mode"));
        return new URL(value.env.ENDPOINTS.binding);
      }),
    objects: ready.then(async (value) => {
      const proxy = await connect<Env>({ url: value.env.ENDPOINTS.app, token: proxyToken });
      return proxy.env.OBJECTS;
    }),
    control: ready.then((value) => value.env.CONTROL),
    service: ready.then((value) => value.env.BOXES),
    dispose: () => ready.then((value) => value.dispose()),
  };
};
