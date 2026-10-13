import { Miniflare, type MiniflareOptions } from "miniflare";
import { readFileSync } from "node:fs";
import { join } from "node:path";

export const runtime = (persist: string, originSource?: string) => {
  const worker: NonNullable<MiniflareOptions["workers"]>[number] = {
    config: {
      name: "cirro",
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
      },
    },
  };
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
