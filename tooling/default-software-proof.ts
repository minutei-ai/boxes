import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Clock, Effect, Redacted, Schema } from "effect";
import { FetchHttpClient } from "effect/http";
import { defaultSoftware } from "../src/default-software";
import { make, makeBinding } from "../src/sdk";
import { prepareSoftwareBase } from "./software-base";
import { runtime } from "./worker-test";
import { defaultSoftwareProof } from "../tests/fixtures/default-software-proof";

const report = await Effect.runPromise(
  Effect.scoped(
    Effect.gen(function* () {
      const startedAt = yield* Clock.currentTimeMillis;
      const bytes = yield* Effect.promise(() =>
        Bun.file(new URL("../dist/kernel/cirro_kernel_bg.wasm", import.meta.url)).arrayBuffer(),
      );
      const base = yield* prepareSoftwareBase({
        kernelDigest: new Bun.CryptoHasher("sha256").update(bytes).digest("hex"),
        artifacts: defaultSoftware,
      });
      const directory = yield* Effect.acquireRelease(
        Effect.promise(() => mkdtemp(join(tmpdir(), "boxes-full-software-"))),
        (path) => Effect.promise(() => rm(path, { recursive: true, force: true })),
      );
      const worker = yield* Effect.acquireRelease(
        Effect.sync(() => runtime(directory, { softwareBase: base.digest, controlled: false })),
        (worker) => Effect.promise(() => worker.dispose()),
      );
      const objects = yield* Effect.promise(() => worker.objects);
      yield* Effect.forEach(
        base.blocks,
        ([hash, bytes]) => Effect.promise(() => objects.put(`software/blobs/${hash}`, bytes)),
        { concurrency: 1, discard: true },
      );
      yield* Effect.promise(() => objects.put(`software/bases/${base.digest}.json`, base.manifest));
      const admin = yield* make({
        url: (yield* Effect.promise(() => worker.ready)).toString(),
        token: Redacted.make("cirro-local-test-credential"),
      });
      yield* admin.create({
        id: "full-image",
        policy: {
          interruptBudget: 100000,
          memoryBytes: 33554432,
          maxOutputBytes: 1048576,
          networkHosts: [],
        },
      });
      const management = yield* admin.mintCapability("full-image", {
        permissions: ["manage"],
        expiresInSeconds: 3600,
      });
      const manager = yield* makeBinding(
        yield* Effect.promise(() => worker.service),
        Redacted.make(management.token),
      );
      yield* Effect.addFinalizer(() =>
        Effect.gen(function* () {
          yield* manager.action("full-image", { op: "vm.dispose" });
          const reclaimed = yield* manager
            .action("full-image", { op: "vm.reclaim", limit: 1000 })
            .pipe(Effect.repeat({ until: (progress) => progress.status !== "pending", times: 7 }));
          if (reclaimed.status !== "complete") return yield* Effect.die(reclaimed);
        }).pipe(Effect.orDie),
      );
      const grant = yield* admin.mintCapability("full-image", {
        permissions: ["read", "write", "execute"],
        expiresInSeconds: 3600,
      });
      const client = yield* makeBinding(
        yield* Effect.promise(() => worker.service),
        Redacted.make(grant.token),
      );
      const privateBefore = yield* Effect.promise(() =>
        objects.list({ prefix: "sandboxes/full-image/blobs/" }),
      );
      if (privateBefore.objects.length !== 0) return yield* Effect.die(privateBefore);
      const proof = yield* defaultSoftwareProof(
        client,
        "full-image",
        defaultSoftware.map((artifact) => artifact.digest),
      );
      return {
        measuredAt: yield* Clock.currentTimeMillis,
        milliseconds: (yield* Clock.currentTimeMillis) - startedAt,
        runtime: "native local Alchemy workerd, R2 and Agent service binding",
        baseDigest: base.digest,
        packageCount: proof.catalog.length,
        commandCount: proof.catalog.reduce(
          (total, item) => total + item.manifest.commands.length,
          0,
        ),
        sharedBlocks: base.blocks.size,
        sharedBytes: Array.from(base.blocks.values()).reduce(
          (total, bytes) => total + bytes.byteLength,
          0,
        ),
        privateSoftwareBlobs: privateBefore.objects.length,
        catalog: proof.catalog,
        runs: proof.runs,
        reclaimed: true,
        scope:
          "Local full default image proof; fixture seeding is separate from deploy-time Alchemy publication; not production latency or billing.",
      };
    }),
  ).pipe(Effect.provide(FetchHttpClient.layer)),
);

console.log(JSON.stringify(report));
