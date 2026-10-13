import { Miniflare, type MiniflareOptions } from "miniflare";
import { readFileSync } from "node:fs";
import { Schema } from "effect";
import { ProcessDelivery } from "../src/contracts";
import { join } from "node:path";

export const runtime = (
  persist: string,
  originSource?: string,
  queueConcurrency = 1,
  consume = true,
) => {
  const worker: NonNullable<MiniflareOptions["workers"]>[number] = {
    config: {
      name: "cirro",
      triggers: [
        {
          type: "queue",
          name: "executions",
          maxBatchSize: 1,
          maxBatchTimeout: 0,
          maxConcurrency: queueConcurrency,
          maxRetries: 100,
        },
      ],
      compatibilityDate: "2026-10-06",
      compatibilityFlags: ["nodejs_compat", "enable_request_signal"],
      manifest: {
        mainModule: "index.js",
        modulesRoot: join(import.meta.dir, "../dist/worker"),
        modules: {
          "index.js": {
            type: "esm",
            contents: readFileSync(join(import.meta.dir, "../dist/worker/index.js"), "utf8"),
          },
          ...Object.fromEntries(
            ["kernel", "guest", "compiler", "wasi", "python"].map((name) => [
              `cirro_${name}_bg.wasm`,
              {
                type: "wasm" as const,
                contents: readFileSync(
                  join(import.meta.dir, `../dist/worker/cirro_${name}_bg.wasm`),
                ),
              },
            ]),
          ),
        },
      },
      env: {
        API_KEY: { type: "text", value: "cirro-local-test-credential" },
        OBJECTS: { type: "r2", name: "cirro-test" },
        EVENTS: { type: "queue", name: "executions" },
      },
    },
  };
  if (!consume) worker.config.triggers = [];
  const workers: NonNullable<MiniflareOptions["workers"]> = [worker];
  if (originSource !== undefined) {
    worker.dev = { outboundService: { type: "worker", worker: "origin" } };
    workers.push({
      config: {
        name: "origin",
        compatibilityDate: "2026-10-06",
        manifest: {
          mainModule: "origin.js",
          modules: { "origin.js": { type: "esm", contents: originSource } },
        },
      },
    });
  }
  return new Miniflare({ resourcePersistencePath: persist, workers });
};

export const deliverProcess = async (
  instance: ReturnType<typeof runtime>,
  sandboxId: string,
  id: string,
) => {
  const bucket = await instance.getR2Bucket("OBJECTS");
  const key = `processes/${sandboxId}/${id}.json`;
  const object = await bucket.head(key);
  if (object === null)
    return Promise.reject(new Error("Process notification fixture requires a persisted receipt"));
  const producer = await instance.getQueueProducer("EVENTS", "cirro");
  await producer.send(Schema.encodeSync(ProcessDelivery)({ key, eTag: object.etag }));
};
