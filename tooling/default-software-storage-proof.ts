import { Clock, Config, Crypto, Effect, Redacted, Schema } from "effect";
import * as BunServices from "@effect/platform-bun/BunServices";
import { FetchHttpClient } from "effect/http";
import { CloudflareApiLive, CloudflareEnvironment } from "alchemy/Cloudflare";
import { currentProfileName } from "alchemy/Auth/Profile";
import { AuthProviders } from "alchemy/Auth/AuthProvider";
import { layerNonInteractive } from "alchemy/Interaction";
import { listObjects } from "@distilled.cloud/cloudflare/r2";
import { getScriptScriptAndVersionSetting } from "@distilled.cloud/cloudflare/workers";
import { make } from "../dist/sdk/sdk.js";
import { Digest, Id, Status } from "../dist/sdk/contracts.js";
import { defaultSoftware } from "../src/default-software";

const Report = Schema.Struct({
  measuredAt: Schema.Int,
  profile: Schema.String,
  worker: Schema.String,
  bucket: Schema.String,
  sandboxId: Id,
  baseDigest: Digest,
  placementMode: Schema.Literal("smart"),
  status: Status,
  catalogPackages: Schema.Int,
  objectsAfterCreate: Schema.Int,
  privateSoftwareBlobsAfterCreate: Schema.Int,
  sharedObjectsBefore: Schema.Int,
  sharedObjectsAfterCollection: Schema.Int,
  reclaimed: Schema.Literal(true),
});
const report = await Effect.runPromise(
  Effect.scoped(
    Effect.gen(function* () {
      const profile = yield* Config.String("ALCHEMY_PROFILE");
      if (profile !== "minutei" || (yield* currentProfileName) !== profile)
        return yield* Effect.die("Unexpected Cloudflare profile");
      const worker = yield* Config.String("CIRRO_WORKER");
      const bucket = yield* Config.String("CIRRO_BUCKET");
      const url = yield* Config.String("CIRRO_URL");
      const token = yield* Config.Redacted("CIRRO_API_KEY");
      const { accountId } = yield* yield* CloudflareEnvironment;
      const settings = yield* getScriptScriptAndVersionSetting({ accountId, scriptName: worker });
      const objectsBinding = settings.bindings?.find((binding) => binding.name === "OBJECTS");
      if (objectsBinding?.type !== "r2_bucket" || objectsBinding.bucketName !== bucket)
        return yield* Effect.die("The selected Worker does not own the selected R2 bucket");
      const placement = settings.placement;
      if (
        placement === null ||
        placement === undefined ||
        !("mode" in placement) ||
        placement.mode !== "smart"
      )
        return yield* Effect.die("Smart Placement is not enabled");
      const baseBinding = settings.bindings?.find((binding) => binding.name === "SOFTWARE_BASE");
      const baseDigest = yield* Effect.gen(function* () {
        if (baseBinding?.type === "plain_text")
          return yield* Schema.decodeUnknownEffect(Digest)(baseBinding.text);
        if (baseBinding?.type === "json")
          return yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Digest))(baseBinding.json);
        return yield* Effect.die("The deployed Worker has no software base binding");
      });
      const before = yield* listObjects({
        accountId,
        bucketName: bucket,
        prefix: "software/blobs/",
        perPage: 1000,
      });
      if (before.resultInfo?.cursor)
        return yield* Effect.die("Incomplete public software inventory");
      const crypto = yield* Crypto.Crypto;
      const sandboxId = `software-storage-${yield* crypto.randomUUIDv4()}`;
      const admin = yield* make({ url, token });
      const measured = yield* Effect.scoped(
        Effect.gen(function* () {
          const status = yield* Effect.acquireRelease(
            admin.create({
              id: sandboxId,
              policy: {
                networkHosts: [],
                interruptBudget: 100000,
                memoryBytes: 8388608,
                maxOutputBytes: 1048576,
              },
            }),
            () =>
              Effect.gen(function* () {
                const management = yield* admin.mintCapability(sandboxId, {
                  permissions: ["manage"],
                  expiresInSeconds: 600,
                });
                const manager = yield* make({ url, token: Redacted.make(management.token) });
                yield* manager.action(sandboxId, { op: "vm.dispose" });
                const collected = yield* manager
                  .action(sandboxId, { op: "vm.reclaim", limit: 1000 })
                  .pipe(
                    Effect.repeat({ until: (progress) => progress.status !== "pending", times: 7 }),
                  );
                if (collected.status !== "complete") return yield* Effect.die(collected);
              }).pipe(Effect.orDie),
          );
          const grant = yield* admin.mintCapability(sandboxId, {
            permissions: ["read"],
            expiresInSeconds: 600,
          });
          const client = yield* make({ url, token: Redacted.make(grant.token) });
          const catalog = yield* client.action(sandboxId, { op: "software.list" });
          if (
            catalog.length !== defaultSoftware.length ||
            defaultSoftware.some(
              (artifact) => !catalog.some((installed) => installed.packageId === artifact.digest),
            )
          )
            return yield* Effect.die("Unexpected default catalog");
          const root = yield* listObjects({
            accountId,
            bucketName: bucket,
            prefix: `sandboxes/${sandboxId}/`,
            perPage: 1000,
          });
          if (
            root.resultInfo?.cursor ||
            root.result.length !== 1 ||
            root.result[0]?.key !== `sandboxes/${sandboxId}/head.json`
          )
            return yield* Effect.die({
              message: "Fresh creation copied private software content",
              keys: root.result.map((object) => object.key),
            });
          const privateBlobs = root.result.filter((object) =>
            object.key?.startsWith(`sandboxes/${sandboxId}/blobs/`),
          );
          if (privateBlobs.length !== 0)
            return yield* Effect.die("Private software blobs were copied");
          return {
            status,
            catalogPackages: catalog.length,
            objectsAfterCreate: root.result.length,
            privateSoftwareBlobsAfterCreate: privateBlobs.length,
          };
        }),
      );
      const after = yield* listObjects({
        accountId,
        bucketName: bucket,
        prefix: "software/blobs/",
        perPage: 1000,
      });
      if (after.resultInfo?.cursor || after.result.length !== before.result.length)
        return yield* Effect.die("Shared software inventory changed during scoped collection");
      return {
        measuredAt: yield* Clock.currentTimeMillis,
        profile,
        worker,
        bucket,
        sandboxId,
        baseDigest,
        placementMode: placement.mode,
        status: measured.status,
        catalogPackages: measured.catalogPackages,
        objectsAfterCreate: measured.objectsAfterCreate,
        privateSoftwareBlobsAfterCreate: measured.privateSoftwareBlobsAfterCreate,
        sharedObjectsBefore: before.result.length,
        sharedObjectsAfterCollection: after.result.length,
        reclaimed: true as const,
      };
    }),
  ).pipe(
    Effect.provide(CloudflareApiLive()),
    Effect.provideService(AuthProviders, {}),
    Effect.provide([FetchHttpClient.layer, BunServices.layer, layerNonInteractive()]),
    Effect.provideService(FetchHttpClient.RequestInit, { keepalive: false }),
  ),
);
console.log(Schema.encodeSync(Schema.fromJsonString(Report))(report));
