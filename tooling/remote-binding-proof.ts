import { bindingConsumer } from "./binding-consumer";
import { terminalProofSources } from "./terminal-proof-inputs";
import { TerminalProof, TerminalProofInput } from "../tests/fixtures/terminal-proof";
import { DescriptorProof } from "../tests/fixtures/descriptor-proof";
import { prepareDescriptorProof } from "../tests/fixtures/descriptor-proof-inputs";
import { downloadPublished } from "../tests/fixtures/published-package";
import { publishedPackages } from "../tests/fixtures/published-software";
import { Clock, Config, Crypto, Effect, Fiber, Redacted, Schedule, Schema } from "effect";
import * as BunServices from "@effect/platform-bun/BunServices";
import { FetchHttpClient } from "effect/http";
import { CloudflareApiLive, createEdgeSession } from "alchemy/Cloudflare";
import { currentProfileName } from "alchemy/Auth/Profile";
import { AuthProviders } from "alchemy/Auth/AuthProvider";
import { layerNonInteractive } from "alchemy/Interaction";
import { make } from "../dist/sdk/sdk.js";
import { RecoveryStatus, RunRecord } from "../dist/sdk/contracts.js";
import { PublicPreviewAccess } from "./preview-access";
import {
  RemoteBindingInput,
  VerifiedRemoteBindingProof,
  remoteRpcTimeoutMs,
  remoteDeadlinePath,
} from "../tests/fixtures/remote-binding-contracts";
import {
  PersistentBindingInput,
  VerifiedPersistentBindingProof,
} from "../tests/fixtures/remote-persistent-binding";

const Report = Schema.Struct({
  measuredAt: Schema.Int,
  profile: Schema.String,
  targetWorker: Schema.String,
  sandboxId: RemoteBindingInput.fields.sandboxId,
  previewOrigin: Schema.String,
  replacementPreviewOrigin: Schema.String,
  consumerBundleSha256: Schema.String,
  sdkVersion: Schema.String,
  sdkModulesSha256: Schema.Record(Schema.String, Schema.String),
  inlineDeadline: Schema.Struct({
    requestedMs: Schema.Literal(remoteRpcTimeoutMs),
    startedAt: RunRecord.fields.startedAt,
    recovery: RecoveryStatus,
  }),
  proof: VerifiedRemoteBindingProof,
  descriptors: DescriptorProof,
  terminal: TerminalProof,
  persistent: Schema.Struct({
    created: VerifiedPersistentBindingProof,
    resumed: VerifiedPersistentBindingProof,
    previousReceiptRetained: Schema.Literal(true),
  }),
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
      const { bytes, version, sdkModulesSha256, consumerBundleSha256 } =
        yield* bindingConsumer(sdkDirectory);
      const cryptoService = yield* Crypto.Crypto;
      const nonce = yield* cryptoService.randomUUIDv4();
      const id = `remote-binding-${nonce}`;
      const admin = yield* make({ url, token });
      yield* Effect.logInfo({ phase: "selected", sandboxId: id, sdkVersion: version });
      yield* admin.create({
        id,
        policy: {
          networkHosts: [],
          interruptBudget: 100000,
          memoryBytes: 8388608,
          maxOutputBytes: 1048576,
        },
      });
      yield* Effect.logInfo({ phase: "created", sandboxId: id });
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
            const reclaimed = yield* client
              .action(id, { op: "vm.reclaim", limit: 1000 })
              .pipe(
                Effect.repeat({ until: (progress) => progress.status !== "pending", times: 7 }),
              );
            if (reclaimed.status !== "complete") return yield* Effect.die(reclaimed);
          }).pipe(Effect.orDie),
      );
      const software = publishedPackages.find((entry) => entry.name === "sh");
      if (software === undefined) return yield* Effect.die("Missing pinned shell package");
      const packageBytes = yield* downloadPublished(software);
      yield* manager.action(id, {
        op: "filesystem.writeFile",
        path: "/tmp/binding-sh.aospkg",
        content: packageBytes.toString("base64"),
        encoding: "base64",
      });
      yield* manager.action(id, {
        op: "software.install",
        source: { path: "/tmp/binding-sh.aospkg", digest: `sha256:${software.digest}` },
      });
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
      const pending = yield* Effect.gen(function* () {
        const response = yield* Effect.promise(() =>
          fetch(session.url, {
            method: "POST",
            keepalive: false,
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
        return yield* Schema.decodeUnknownEffect(Schema.fromJsonString(VerifiedRemoteBindingProof))(
          body,
        );
      }).pipe(Effect.forkChild);
      const active = yield* manager.action(id, { op: "process.get", id: "rpc-callback" }).pipe(
        Effect.retry({
          times: 40,
          schedule: Schedule.spaced("100 millis"),
          while: (failure) => failure._tag === "BoxesError" && failure.status === 404,
        }),
      );
      const recovery = yield* manager.action(id, {
        op: "process.recovery.status",
        id: "rpc-callback",
      });
      if (
        active.status !== "running" ||
        recovery.state !== "running" ||
        recovery.resumable ||
        recovery.checkpoints !== 0 ||
        recovery.deadlineAt !== active.startedAt + remoteRpcTimeoutMs
      )
        return yield* Effect.die("Native RPC did not persist its requested inline deadline");
      const inlineDeadline = {
        requestedMs: remoteRpcTimeoutMs,
        startedAt: active.startedAt,
        recovery,
      } as const;
      yield* manager.action(id, {
        op: "filesystem.writeFile",
        path: remoteDeadlinePath,
        content: "observed",
        encoding: "utf8",
      });
      const proof = yield* Fiber.join(pending);
      yield* prepareDescriptorProof(manager, id);
      const descriptorResponse = yield* Effect.promise(() =>
        fetch(new URL("/descriptors", session.url), {
          method: "POST",
          keepalive: false,
          headers: { ...session.headers, "content-type": "application/json" },
          body: Schema.encodeSync(Schema.fromJsonString(RemoteBindingInput))({
            sandboxId: id,
            token: grant.token,
          }),
          signal: AbortSignal.timeout(120000),
        }),
      );
      const descriptorBody = yield* Effect.promise(() => descriptorResponse.text());
      if (descriptorResponse.status !== 200)
        return yield* Effect.die({
          message: "Descriptor binding proof failed",
          status: descriptorResponse.status,
          body: descriptorBody,
        });
      const descriptors = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(DescriptorProof))(
        descriptorBody,
      );
      const createdResponse = yield* Effect.promise(() =>
        fetch(new URL("/persistent", session.url), {
          method: "POST",
          keepalive: false,
          headers: { ...session.headers, "content-type": "application/json" },
          body: Schema.encodeSync(Schema.fromJsonString(PersistentBindingInput))({
            phase: "create",
            sandboxId: id,
            token: grant.token,
          }),
          signal: AbortSignal.timeout(120000),
        }),
      );
      const createdBody = yield* Effect.promise(() => createdResponse.text());
      if (createdResponse.status !== 200)
        return yield* Effect.die({
          message: "Persistent binding writer failed",
          status: createdResponse.status,
          body: createdBody,
        });
      const created = yield* Schema.decodeUnknownEffect(
        Schema.fromJsonString(VerifiedPersistentBindingProof),
      )(createdBody);
      if (created.phase !== "create")
        return yield* Effect.die("Persistent binding writer returned the wrong phase");
      const readonly = yield* admin.mintCapability(id, {
        permissions: ["read", "execute"],
        expiresInSeconds: 600,
      });
      const replacement = yield* createEdgeSession({
        scriptName: `boxes-replacement-${nonce}`,
        compatibilityDate: "2026-10-06",
        files: [new File([bytes], "index.js", { type: "application/javascript+module" })],
        bindings: [
          { name: "BOXES", type: "service", service: targetWorker },
          { name: "BOXES_AGENT", type: "service", service: targetWorker, entrypoint: "Agent" },
        ],
      });
      const resumedResponse = yield* Effect.promise(() =>
        fetch(new URL("/persistent", replacement.url), {
          method: "POST",
          keepalive: false,
          headers: { ...replacement.headers, "content-type": "application/json" },
          body: Schema.encodeSync(Schema.fromJsonString(PersistentBindingInput))({
            phase: "resume",
            sandboxId: id,
            token: readonly.token,
          }),
          signal: AbortSignal.timeout(120000),
        }),
      );
      const resumedBody = yield* Effect.promise(() => resumedResponse.text());
      if (resumedResponse.status !== 200)
        return yield* Effect.die({
          message: "Persistent binding reader failed",
          status: resumedResponse.status,
          body: resumedBody,
        });
      const resumed = yield* Schema.decodeUnknownEffect(
        Schema.fromJsonString(VerifiedPersistentBindingProof),
      )(resumedBody);
      if (resumed.phase !== "resume")
        return yield* Effect.die("Persistent binding reader returned the wrong phase");
      const persistentFile = yield* manager.action(id, {
        op: "filesystem.readFile",
        path: "/persistent.txt",
      });
      if (
        persistentFile.content !== created.value.content ||
        persistentFile.encoding !== created.value.encoding ||
        persistentFile.content !== resumed.value.content ||
        persistentFile.encoding !== resumed.value.encoding
      )
        return yield* Effect.die("Persistent binding retained an unauthorized mutation");
      const previous = yield* manager.action(id, { op: "process.get", id: "rpc-callback" });
      if (previous.status !== "exited" || previous.output?.exitCode !== 0)
        return yield* Effect.die("Context disposal changed an unrelated process receipt");
      const retained = yield* manager.action(id, {
        op: "filesystem.readFile",
        path: "/binding.txt",
      });
      if (retained.content !== proof.file.content || retained.encoding !== proof.file.encoding)
        return yield* Effect.die("Binding write was not retained by the deployed sandbox");
      const terminalSources = yield* terminalProofSources();
      const terminalResponse = yield* Effect.tryPromise(() =>
        fetch(new URL("/terminal", session.url), {
          method: "POST",
          keepalive: false,
          headers: { ...session.headers, "content-type": "application/json" },
          signal: AbortSignal.timeout(120000),
          body: Schema.encodeSync(Schema.fromJsonString(TerminalProofInput))({
            sandboxId: id,
            token: grant.token,
            ...terminalSources,
          }),
        }),
      );
      if (terminalResponse.status !== 200)
        return yield* Effect.die({
          status: terminalResponse.status,
          body: yield* Effect.promise(() => terminalResponse.text()),
        });
      const terminal = yield* Schema.decodeUnknownEffect(TerminalProof)(
        yield* Effect.tryPromise(() => terminalResponse.json()),
      );
      return {
        measuredAt: yield* Clock.currentTimeMillis,
        profile,
        targetWorker,
        sandboxId: id,
        previewOrigin: session.url,
        replacementPreviewOrigin: replacement.url,
        consumerBundleSha256,
        sdkVersion: version,
        sdkModulesSha256,
        inlineDeadline,
        proof,
        descriptors,
        terminal,
        persistent: { created, resumed, previousReceiptRetained: true as const },
      };
    }),
  ).pipe(
    Effect.provide(PublicPreviewAccess),
    Effect.provide(CloudflareApiLive()),
    Effect.provideService(AuthProviders, {}),
    Effect.provide([FetchHttpClient.layer, BunServices.layer, layerNonInteractive()]),
    Effect.provideService(FetchHttpClient.RequestInit, { keepalive: false }),
  ),
);
console.log(Schema.encodeSync(Schema.fromJsonString(Report))(report));
