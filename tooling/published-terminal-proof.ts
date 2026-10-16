import { defaultSoftware } from "../src/default-software";
import { Clock, Config, Crypto, Effect, Redacted, Schema } from "effect";
import * as BunServices from "@effect/platform-bun/BunServices";
import { FetchHttpClient } from "effect/http";
import { CloudflareApiLive, createEdgeSession } from "alchemy/Cloudflare";
import { currentProfileName } from "alchemy/Auth/Profile";
import { AuthProviders } from "alchemy/Auth/AuthProvider";
import { layerNonInteractive } from "alchemy/Interaction";
import { make } from "../dist/sdk/sdk.js";
import { Id, PackagePreparation } from "../src/contracts";
import { bindingConsumer } from "./binding-consumer";
import { PublicPreviewAccess } from "./preview-access";
import {
  PublishedTerminalInput,
  PublishedTerminalProof,
  publishedTerminalProof,
  TerminalBackend,
  TerminalObservationFailure,
} from "../tests/fixtures/published-terminal-proof";

const Transport = Schema.Literals(["binding", "http"]);
const [transport, backend] = Schema.decodeUnknownSync(Schema.Tuple([Transport, TerminalBackend]))(
  Bun.argv.slice(2),
);
const Report = Schema.Struct({
  measuredAt: Schema.Int,
  profile: Schema.Literal("minutei"),
  targetWorker: Schema.String,
  transport: Transport,
  sandboxId: Id,
  sdkVersion: Schema.String,
  package: PackagePreparation.fields.installed,
  previewOrigin: Schema.NullOr(Schema.String),
  consumerBundleSha256: Schema.NullOr(Schema.String),
  proof: PublishedTerminalProof,
  reclaimed: Schema.Literal(true),
});
const report = await Effect.runPromise(
  Effect.scoped(
    Effect.gen(function* () {
      const profile = yield* Config.String("ALCHEMY_PROFILE");
      if (profile !== "minutei" || (yield* currentProfileName) !== profile)
        return yield* Effect.die("Unexpected Cloudflare profile");
      const targetWorker = yield* Config.String("CIRRO_WORKER");
      const url = yield* Config.String("CIRRO_URL");
      const sdkDirectory = yield* Config.String("CIRRO_SDK_DIRECTORY");
      const consumer = yield* bindingConsumer(sdkDirectory);
      const cryptoService = yield* Crypto.Crypto;
      const id = `terminal-proof-${yield* cryptoService.randomUUIDv4()}`;
      const admin = yield* make({ url, token: yield* Config.Redacted("CIRRO_API_KEY") });
      yield* Effect.logInfo({
        phase: "terminal.selected",
        sandboxId: id,
        transport,
        backend,
        targetWorker,
      });
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
        (manager) =>
          Effect.gen(function* () {
            yield* manager.action(id, { op: "vm.dispose" });
            const progress = yield* manager
              .action(id, { op: "vm.reclaim", limit: 1000 })
              .pipe(
                Effect.repeat({ until: (progress) => progress.status !== "pending", times: 7 }),
              );
            if (progress.status !== "complete") return yield* Effect.die(progress);
            yield* Effect.logInfo({ phase: "terminal.reclaimed", sandboxId: id });
          }).pipe(Effect.orDie),
      );
      const software = defaultSoftware.find((item) => item.name === "sh");
      if (software === undefined) return yield* Effect.die("Missing pinned shell");
      const catalog = yield* manager.action(id, { op: "software.list" });
      const installed = catalog.find((item) => item.packageId === software.digest);
      if (installed === undefined)
        return yield* Effect.die("The fresh sandbox did not receive the default shell");
      yield* Effect.logInfo({
        phase: "terminal.available",
        sandboxId: id,
        digest: software.digest,
      });
      const proof = yield* Effect.gen(function* () {
        if (transport === "http")
          return {
            proof: yield* publishedTerminalProof(manager, id, backend).pipe(
              Effect.tapErrorTag("TerminalObservationFailure", (failure) =>
                Effect.logError(
                  Schema.encodeSync(Schema.fromJsonString(TerminalObservationFailure))(failure),
                ),
              ),
            ),
            previewOrigin: null,
            consumerBundleSha256: null,
          };
        const grant = yield* admin.mintCapability(id, {
          permissions: ["read", "write", "execute"],
          expiresInSeconds: 600,
        });
        const session = yield* createEdgeSession({
          scriptName: `boxes-terminal-${yield* cryptoService.randomUUIDv4()}`,
          compatibilityDate: "2026-10-06",
          files: [
            new File([consumer.bytes], "index.js", { type: "application/javascript+module" }),
          ],
          bindings: [
            { name: "BOXES", type: "service", service: targetWorker },
            { name: "BOXES_AGENT", type: "service", service: targetWorker, entrypoint: "Agent" },
          ],
        });
        const response = yield* Effect.promise(() =>
          fetch(new URL("/published-terminal", session.url), {
            method: "POST",
            keepalive: false,
            signal: AbortSignal.timeout(120000),
            headers: { ...session.headers, "content-type": "application/json" },
            body: Schema.encodeSync(Schema.fromJsonString(PublishedTerminalInput))({
              sandboxId: id,
              token: grant.token,
              backend,
            }),
          }),
        );
        if (response.status !== 200)
          return yield* Effect.die({
            status: response.status,
            body: yield* Effect.promise(() => response.text()),
          });
        return {
          proof: yield* Schema.decodeUnknownEffect(Schema.fromJsonString(PublishedTerminalProof))(
            yield* Effect.promise(() => response.text()),
          ),
          previewOrigin: session.url,
          consumerBundleSha256: consumer.consumerBundleSha256,
        };
      });
      return {
        measuredAt: yield* Clock.currentTimeMillis,
        profile: "minutei" as const,
        targetWorker,
        transport,
        sandboxId: id,
        sdkVersion: consumer.version,
        package: installed,
        ...proof,
      };
    }),
  ).pipe(
    Effect.map((proof) => ({ ...proof, reclaimed: true as const })),
    Effect.provide(PublicPreviewAccess),
    Effect.provide(CloudflareApiLive()),
    Effect.provideService(AuthProviders, {}),
    Effect.provide([FetchHttpClient.layer, BunServices.layer, layerNonInteractive()]),
    Effect.provideService(FetchHttpClient.RequestInit, { keepalive: false }),
  ),
);
console.log(Schema.encodeSync(Schema.fromJsonString(Report))(report));
