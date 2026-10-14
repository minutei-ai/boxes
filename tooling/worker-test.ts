import { Clock, Effect } from "effect";
import { Runtime, PlatformProxy } from "@alchemy.run/cloudflare-runtime/core";
import {
  R2Bucket,
  Text,
  Json,
  Queue,
  Service,
} from "@alchemy.run/cloudflare-runtime/core/bindings";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Env } from "../src/resources";
import type { Control } from "../tests/fixtures/clock-worker";

type TestEnv = Env & { APP_URL: string; CONTROL: Fetcher<Control> };
export const runtime = (persist: string, advance = 0, clockStart?: number) => {
  const name = `boxes-test-${crypto.randomUUID()}`;
  const start = clockStart ?? Effect.runSync(Clock.currentTimeMillis);
  const workerBindings = [
    R2Bucket.local({ binding: "OBJECTS", id: "boxes-test" }),
    Text.local("API_KEY", "cirro-local-test-credential"),
    Json.local("CLOCK_START", start),
    Json.local("CLOCK_ADVANCE", advance),
    Queue.local({ binding: "EVENTS", queueName: "executions" }),
    Service.self("SELF"),
  ];
  const modules = [
    {
      name: "index.js",
      type: "ESModule" as const,
      content: readFileSync(join(import.meta.dir, "../dist/clock-worker/index.js"), "utf8"),
    },
    ...["kernel", "guest", "compiler", "wasi", "python"].map((module) => ({
      name: `cirro_${module}_bg.wasm`,
      type: "Wasm" as const,
      content: readFileSync(join(import.meta.dir, `../dist/clock-worker/cirro_${module}_bg.wasm`)),
    })),
  ];
  const bindings = [
    R2Bucket.local({ binding: "OBJECTS", id: "boxes-test" }),
    Effect.gen(function* () {
      const workerRuntime = yield* Runtime;
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
        })
        .pipe(Effect.orDie);
      return yield* Text.local("APP_URL", url.href);
    }),
    Service.local({ binding: "CONTROL", scriptName: name, entrypoint: "Control" }),
  ];
  const ready = PlatformProxy.getPlatformProxy<TestEnv, typeof bindings>({
    name: `${name}-proxy`,
    bindings,
    persist: { directory: persist },
    compatibilityFlags: ["experimental", "service_binding_extra_handlers"],
  });
  return {
    time: start + advance,
    ready: ready.then((value) => new URL(value.env.APP_URL)),
    objects: ready.then((value) => value.env.OBJECTS),
    control: ready.then((value) => value.env.CONTROL),
    dispose: () => ready.then((value) => value.dispose()),
  };
};
