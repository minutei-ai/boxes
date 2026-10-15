import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { Effect } from "effect";
import {
  PATH_ENV,
  HEADER_TOKEN,
} from "@alchemy.run/cloudflare-runtime/core/platform-proxy/PlatformProxyProtocol";
import { runtime } from "../tooling/worker-test";

test(
  "native binding inspection uses the owning Worker, requires its token and isolates buckets",
  () =>
    Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const directories = yield* Effect.forEach(["first", "second"], (name) =>
            Effect.acquireRelease(
              Effect.promise(() => mkdtemp(`/tmp/boxes-owner-${name}-`)),
              (directory) => Effect.promise(() => rm(directory, { recursive: true, force: true })),
            ),
          );
          const workers = yield* Effect.forEach(directories, (directory) =>
            Effect.acquireRelease(
              Effect.sync(() => runtime(directory)),
              (worker) => Effect.promise(() => worker.dispose()),
            ),
          );
          const first = workers[0];
          const second = workers[1];
          const origin = yield* Effect.promise(() => first.ready);
          const denied = yield* Effect.promise(() => fetch(new URL(PATH_ENV, origin)));
          expect(denied.status).toBe(401);
          yield* Effect.promise(() => denied.arrayBuffer());
          const invalid = yield* Effect.promise(() =>
            fetch(new URL(PATH_ENV, origin), { headers: { [HEADER_TOKEN]: "wrong-token" } }),
          );
          expect(invalid.status).toBe(401);
          yield* Effect.promise(() => invalid.arrayBuffer());
          const firstObjects = yield* Effect.promise(() => first.objects);
          const secondObjects = yield* Effect.promise(() => second.objects);
          const key = "ownership/same-key";
          expect(yield* Effect.promise(() => firstObjects.put(key, "first"))).not.toBeNull();
          expect(yield* Effect.promise(() => secondObjects.get(key))).toBeNull();
          expect(yield* Effect.promise(() => secondObjects.put(key, "second"))).not.toBeNull();
          const firstValue = yield* Effect.promise(() => firstObjects.get(key));
          const secondValue = yield* Effect.promise(() => secondObjects.get(key));
          if (firstValue === null || secondValue === null)
            return yield* Effect.die("Missing isolated bucket value");
          expect(yield* Effect.promise(() => firstValue.text())).toBe("first");
          expect(yield* Effect.promise(() => secondValue.text())).toBe("second");
        }),
      ),
    ),
  15000,
);
