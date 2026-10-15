import { Clock, Config, Crypto, Effect, Layer, Redacted, Schema } from "effect";
import { join } from "node:path";
import * as BunServices from "@effect/platform-bun/BunServices";
import { FetchHttpClient } from "effect/http";
import { Access, CloudflareApiLive, createEdgeSession } from "alchemy/Cloudflare";
import { currentProfileName } from "alchemy/Auth/Profile";
import { AuthProviders } from "alchemy/Auth/AuthProvider";
import { layerNonInteractive } from "alchemy/Interaction";
import { make } from "../dist/sdk/sdk.js";
import {
  RemoteBindingInput,
  VerifiedRemoteBindingProof,
} from "../tests/fixtures/remote-binding-worker";

const PublicPreviewAccess = Layer.succeed(
  Access.Access,
  Access.Access.of({
    getAccessHeaders: Effect.fn("remoteBindingProof.publicPreviewAccess")(function* (
      domain: string,
    ) {
      const response = yield* Effect.promise((signal) =>
        fetch(`https://${domain}`, { redirect: "manual", signal }),
      ).pipe(
        Effect.timeoutOrElse({
          duration: 5000,
          orElse: () =>
            Effect.fail(
              new Access.AccessError({ message: "Preview access verification timed out" }),
            ),
        }),
      );
      const body = response.body;
      if (body !== null) yield* Effect.promise(() => body.cancel());
      if ((response.status >= 300 && response.status < 400) || response.status >= 500)
        return yield* new Access.AccessError({
          message: "Preview access could not be verified without interactive authentication",
        });
      return {};
    }),
  }),
);
const Report = Schema.Struct({
  measuredAt: Schema.Int,
  profile: Schema.String,
  targetWorker: Schema.String,
  previewOrigin: Schema.String,
  consumerBundleSha256: Schema.String,
  sdkVersion: Schema.String,
  sdkModulesSha256: Schema.Record(Schema.String, Schema.String),
  proof: VerifiedRemoteBindingProof,
});
const report = await Effect.runPromise(
  Effect.scoped(
    Effect.gen(function* () {
      const profile = yield* Config.String("ALCHEMY_PROFILE");
      if ((yield* currentProfileName) !== profile)
        return yield* Effect.die("Alchemy profile selection did not match the requested profile");
      const targetWorker = yield* Config.String("CIRRO_WORKER");
      const url = yield* Config.String("CIRRO_URL");
      const token = yield* Config.Redacted("CIRRO_API_KEY");
      const sdkDirectory = yield* Config.String("CIRRO_SDK_DIRECTORY");
      const sdkPackage = yield* Schema.decodeUnknownEffect(
        Schema.Struct({ name: Schema.Literal("@minutei-ai/boxes"), version: Schema.String }),
      )(yield* Effect.promise(() => Bun.file(join(sdkDirectory, "package.json")).json()));
      const sdkModules = new Map([
        ["../../src/sdk", Bun.resolveSync("@minutei-ai/boxes", sdkDirectory)],
        ["../../src/sdk-rpc", Bun.resolveSync("@minutei-ai/boxes/rpc", sdkDirectory)],
        ["../../src/contracts", Bun.resolveSync("@minutei-ai/boxes/contracts", sdkDirectory)],
      ]);
      const sdkModulesSha256 = Object.fromEntries(
        yield* Effect.forEach(sdkModules, ([name, path]) =>
          Effect.gen(function* () {
            const bytes = yield* Effect.promise(() => Bun.file(path).arrayBuffer());
            const digest = Buffer.from(
              yield* Effect.promise(() => crypto.subtle.digest("SHA-256", bytes)),
            ).toString("hex");
            return [name, digest] as const;
          }),
        ),
      );
      const built = yield* Effect.promise(() =>
        Bun.build({
          entrypoints: ["tests/fixtures/remote-binding-worker.ts"],
          target: "browser",
          format: "esm",
          minify: true,
          external: ["cloudflare:workers"],
          plugins: [
            {
              name: "installed-boxes-sdk",
              setup(builder) {
                builder.onResolve(
                  { filter: /^\.\.\/\.\.\/src\/(sdk|sdk-rpc|contracts)$/ },
                  (args) => {
                    const path = sdkModules.get(args.path);
                    if (path === undefined) return;
                    return { path };
                  },
                );
                builder.onResolve({ filter: /^effect($|\/)/ }, (args) => ({
                  path: Bun.resolveSync(args.path, sdkDirectory),
                }));
              },
            },
          ],
        }),
      );
      const module = built.outputs[0];
      if (!built.success || module === undefined || built.outputs.length !== 1)
        return yield* Effect.die({ message: "Binding consumer bundle failed", logs: built.logs });
      const bytes = yield* Effect.promise(() => module.arrayBuffer());
      const consumerBundleSha256 = Buffer.from(
        yield* Effect.promise(() => crypto.subtle.digest("SHA-256", bytes)),
      ).toString("hex");
      const cryptoService = yield* Crypto.Crypto;
      const nonce = yield* cryptoService.randomUUIDv4();
      const id = `remote-binding-${nonce}`;
      const admin = yield* make({ url, token });
      yield* admin.create({
        id,
        policy: {
          networkHosts: [],
          interruptBudget: 10000,
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
        (client) =>
          Effect.gen(function* () {
            yield* client.action(id, { op: "vm.dispose" }).pipe(Effect.orDie);
            const denied = yield* client
              .action(id, { op: "filesystem.readFile", path: "/binding.txt" })
              .pipe(Effect.result);
            if (
              denied._tag !== "Failure" ||
              denied.failure._tag !== "BoxesError" ||
              denied.failure.status !== 404
            )
              return yield* Effect.die("Disposed binding sandbox remained publicly readable");
          }),
      );
      const grant = yield* admin.mintCapability(id, {
        permissions: ["read", "write", "execute"],
        expiresInSeconds: 600,
      });
      const session = yield* createEdgeSession({
        scriptName: `boxes-binding-${nonce}`,
        compatibilityDate: "2026-10-06",
        files: [new File([bytes], "index.js", { type: "application/javascript+module" })],
        bindings: [
          { name: "BOXES", type: "service", service: targetWorker },
          { name: "BOXES_AGENT", type: "service", service: targetWorker, entrypoint: "Agent" },
        ],
      });
      const response = yield* Effect.promise(() =>
        fetch(session.url, {
          method: "POST",
          headers: { ...session.headers, "content-type": "application/json" },
          body: Schema.encodeSync(Schema.fromJsonString(RemoteBindingInput))({
            sandboxId: id,
            token: grant.token,
          }),
          signal: AbortSignal.timeout(120000),
        }),
      );
      const body = yield* Effect.promise(() => response.text());
      if (response.status !== 200)
        return yield* Effect.die({
          message: "Remote binding consumer failed",
          status: response.status,
          body,
        });
      const proof = yield* Schema.decodeUnknownEffect(
        Schema.fromJsonString(VerifiedRemoteBindingProof),
      )(body);
      const retained = yield* manager.action(id, {
        op: "filesystem.readFile",
        path: "/binding.txt",
      });
      if (retained.content !== proof.file.content || retained.encoding !== proof.file.encoding)
        return yield* Effect.die("Binding write was not retained by the deployed sandbox");
      return {
        measuredAt: yield* Clock.currentTimeMillis,
        profile,
        targetWorker,
        previewOrigin: session.url,
        consumerBundleSha256,
        sdkVersion: sdkPackage.version,
        sdkModulesSha256,
        proof,
      };
    }),
  ).pipe(
    Effect.provide(PublicPreviewAccess),
    Effect.provide(CloudflareApiLive()),
    Effect.provideService(AuthProviders, {}),
    Effect.provide([FetchHttpClient.layer, BunServices.layer, layerNonInteractive()]),
  ),
);
console.log(Schema.encodeSync(Schema.fromJsonString(Report))(report));
