import { Miniflare } from "miniflare";
import { readFileSync } from "node:fs";
import { join } from "node:path";

export const runtime = (persist: string) =>
  new Miniflare({
    resourcePersistencePath: persist,
    workers: [
      {
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
              "cirro_kernel_bg.wasm": {
                type: "wasm",
                contents: readFileSync(
                  join(import.meta.dir, "../dist/worker/cirro_kernel_bg.wasm"),
                ),
              },
            },
          },
          env: {
            API_KEY: { type: "text", value: "cirro-local-test-credential" },
            OBJECTS: { type: "r2", name: "cirro-test" },
            LOADER: { type: "worker-loader" },
          },
          exports: { Guest: { type: "worker" } },
        },
      },
    ],
  });
