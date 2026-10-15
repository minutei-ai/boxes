import { Clock, Config, Crypto, Effect, Match, Redacted, Schema } from "effect";
import * as BunServices from "@effect/platform-bun/BunServices";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http";
import { CloudflareApiLive, createEdgeSession } from "alchemy/Cloudflare";
import { currentProfileName } from "alchemy/Auth/Profile";
import { AuthProviders } from "alchemy/Auth/AuthProvider";
import { layerNonInteractive } from "alchemy/Interaction";
import { make } from "@minutei-ai/boxes";
import { Id, ReclamationProgress } from "@minutei-ai/boxes/contracts";
import { PublicPreviewAccess } from "./preview-access";

const Existing = Schema.Tuple([Schema.Literal("--collect"), Id]);
const Smoke = Schema.Tuple([Schema.Literal("--smoke")]);
const invocation = Schema.decodeUnknownSync(Schema.Union([Schema.Tuple([]), Existing, Smoke]))(
  Bun.argv.slice(2),
);
const Collection = Schema.Struct({
  measuredAt: Schema.Int,
  profile: Schema.String,
  targetWorker: Schema.String,
  sandboxId: Id,
  previewOrigins: Schema.Array(Schema.String),
  consumerBundleSha256: Schema.String,
  first: ReclamationProgress,
  resumed: Schema.Array(ReclamationProgress),
  recreateDenied: Schema.Literal(409),
  nonManagementGrantDenied: Schema.Literal(403),
  status: ReclamationProgress.fields.status,
});
const Report = Schema.Union([
  Schema.Struct({ ...Collection.fields, kind: Schema.Literal("existing") }),
  Schema.Struct({
    ...Collection.fields,
    kind: Schema.Literal("fixture"),
    files: Schema.Int,
    writes: Schema.Array(Schema.Struct({ files: Schema.Int, milliseconds: Schema.Number })),
    verifiedContents: Schema.Literal(3),
    liveDenied: Schema.Literal(409),
    readonlyDenied: Schema.Literal(403),
    readDenied: Schema.Literal(404),
  }),
]);
const report = await Effect.runPromise(
  Effect.scoped(
    Effect.gen(function* () {
      const profile = yield* Config.String("ALCHEMY_PROFILE");
      if ((yield* currentProfileName) !== profile)
        return yield* Effect.die("Alchemy profile did not match the requested profile");
      const targetWorker = yield* Config.String("CIRRO_WORKER");
      const url = yield* Config.String("CIRRO_URL");
      const token = yield* Config.Redacted("CIRRO_API_KEY");
      const built = yield* Effect.promise(() =>
        Bun.build({
          entrypoints: ["tests/fixtures/reclamation-binding-worker.ts"],
          target: "browser",
          format: "esm",
          minify: true,
          external: ["cloudflare:workers"],
        }),
      );
      const module = built.outputs[0];
      if (!built.success || module === undefined || built.outputs.length !== 1)
        return yield* Effect.die({
          message: "Reclamation consumer bundle failed",
          logs: built.logs,
        });
      const bytes = yield* Effect.promise(() => module.arrayBuffer());
      const consumerBundleSha256 = Buffer.from(
        yield* Effect.promise(() => crypto.subtle.digest("SHA-256", bytes)),
      ).toString("hex");
      const cryptoService = yield* Crypto.Crypto;
      const nonce = yield* cryptoService.randomUUIDv4();
      const id = Match.value(invocation).pipe(
        Match.when(Schema.is(Existing), ([, sandboxId]) => sandboxId),
        Match.orElse(() => `reclaim-${nonce}`),
      );
      const policy = {
        networkHosts: [],
        interruptBudget: 1000,
        memoryBytes: 8388608,
        maxOutputBytes: 1048576,
      };
      const admin = yield* make({ url, token });
      yield* Effect.logInfo({ phase: "selected", sandboxId: id });
      const fixture = yield* Effect.gen(function* () {
        if (Schema.is(Existing)(invocation)) return null;
        yield* admin.create({ id, policy, environment: { CLEANUP_PROOF: "erase-me" } });
        const grant = yield* admin.mintCapability(id, {
          permissions: ["read", "write", "execute", "manage"],
          expiresInSeconds: 1800,
        });
        const manager = yield* Effect.acquireRelease(
          make({ url, token: Redacted.make(grant.token) }),
          (client) => client.action(id, { op: "vm.dispose" }).pipe(Effect.orDie),
        );
        yield* Effect.logInfo({ phase: "created", sandboxId: id });
        const files = Match.value(invocation).pipe(
          Match.when(Schema.is(Smoke), () => 8),
          Match.orElse(() => 1005),
        );
        const writes = yield* Effect.forEach(
          Array.from({ length: Math.ceil(files / 128) }, (_, i) => i),
          (batch) =>
            Effect.gen(function* () {
              const entries = Array.from(
                { length: Math.min(128, files - batch * 128) },
                (_, offset) => {
                  const index = batch * 128 + offset;
                  return {
                    path: `/proof-${String(index).padStart(4, "0")}`,
                    content: `cleanup-object-${index}`,
                    encoding: "utf8" as const,
                  };
                },
              );
              const started = yield* Clock.monotonicTimeNanos;
              const result = yield* manager.action(id, { op: "filesystem.writeFiles", entries });
              const milliseconds = Number((yield* Clock.monotonicTimeNanos) - started) / 1000000;
              if (
                result.length !== entries.length ||
                result.some((item, index) => !item.success || item.path !== entries[index].path)
              )
                return yield* Effect.die("Reclamation fixture batch failed");
              yield* Effect.logInfo({
                phase: "files-staged",
                sandboxId: id,
                batch: batch + 1,
                files: result.length,
              });
              return { files: result.length, milliseconds };
            }),
        );
        const samples = [0, Math.floor(files / 2), files - 1];
        const read = yield* manager.action(id, {
          op: "filesystem.readFiles",
          paths: samples.map((index) => `/proof-${String(index).padStart(4, "0")}`),
        });
        if (
          read.length !== samples.length ||
          read.some(
            (entry, index) =>
              entry.content !== Buffer.from(`cleanup-object-${samples[index]}`).toString("base64"),
          )
        )
          return yield* Effect.die("Remote staged content verification failed");
        const run = yield* manager.action(id, {
          op: "process.run",
          id: "completed",
          language: "javascript",
          source: 'export default ({console}) => { console.log("cleanup-output"); return 42; }',
        });
        if (run.status !== "exited" || run.output?.result !== 42)
          return yield* Effect.die("Reclamation fixture execution failed");
        const scheduledAt = grant.expiresAt - 60000;
        if (scheduledAt <= (yield* Clock.currentTimeMillis) + 60000)
          return yield* Effect.die("Fixture authority is too close to expiry to schedule safely");
        yield* manager.action(id, {
          op: "cron.schedule",
          id: "scheduled",
          schedule: new Date(scheduledAt).toISOString(),
          overlap: "allow",
          execution: { op: "typescript.evaluate", id: "seed", expression: "42" },
        });
        yield* manager.action(id, { op: "cron.cancel", id: "scheduled" });
        return { manager, files, writes };
      });
      const session = yield* createEdgeSession({
        scriptName: `boxes-reclaim-${nonce}`,
        compatibilityDate: "2026-10-06",
        files: [new File([bytes], "index.js", { type: "application/javascript+module" })],
        bindings: [{ name: "BOXES", type: "service", service: targetWorker }],
      });
      const http = yield* HttpClient.HttpClient;
      const previewHttp = http.pipe(
        HttpClient.mapRequest(HttpClientRequest.setHeaders(session.headers)),
      );
      const owner = yield* admin.mintCapability(id, {
        permissions: ["manage"],
        expiresInSeconds: 1800,
      });
      const firstClient = yield* make({ url: session.url, token: Redacted.make(owner.token) }).pipe(
        Effect.provideService(HttpClient.HttpClient, previewHttp),
      );
      const denials = yield* Effect.gen(function* () {
        if (fixture === null) return null;
        const live = yield* firstClient
          .action(id, { op: "vm.reclaim", limit: 1 })
          .pipe(Effect.result);
        if (
          live._tag !== "Failure" ||
          live.failure._tag !== "BoxesError" ||
          live.failure.status !== 409
        )
          return yield* Effect.die("Live reclamation was not denied");
        const readGrant = yield* admin.mintCapability(id, {
          permissions: ["read"],
          expiresInSeconds: 1800,
        });
        const reader = yield* make({
          url: session.url,
          token: Redacted.make(readGrant.token),
        }).pipe(Effect.provideService(HttpClient.HttpClient, previewHttp));
        const forbidden = yield* reader
          .action(id, { op: "vm.reclaim", limit: 1000 })
          .pipe(Effect.result);
        if (
          forbidden._tag !== "Failure" ||
          forbidden.failure._tag !== "BoxesError" ||
          forbidden.failure.status !== 403
        )
          return yield* Effect.die("Readonly reclamation was not denied");
        yield* fixture.manager.action(id, { op: "vm.dispose" });
        return { liveDenied: 409 as const, readonlyDenied: 403 as const };
      });
      const first = yield* firstClient.action(id, { op: "vm.reclaim", limit: 1 });
      if (
        fixture !== null &&
        (first.status !== "pending" || first.removed !== 1 || first.phase !== "processes")
      )
        return yield* Effect.die(
          "First native collection batch did not remove its terminal receipt",
        );
      const renewed = yield* admin.mintCapability(id, {
        permissions: ["manage"],
        expiresInSeconds: 1800,
      });
      const replacement = yield* createEdgeSession({
        scriptName: `boxes-reclaim-replacement-${nonce}`,
        compatibilityDate: "2026-10-06",
        files: [new File([bytes], "index.js", { type: "application/javascript+module" })],
        bindings: [{ name: "BOXES", type: "service", service: targetWorker }],
      });
      const replacementClient = yield* make({
        url: replacement.url,
        token: Redacted.make(renewed.token),
      }).pipe(
        Effect.provideService(
          HttpClient.HttpClient,
          http.pipe(HttpClient.mapRequest(HttpClientRequest.setHeaders(replacement.headers))),
        ),
      );
      const resumed: (typeof ReclamationProgress.Type)[] = [];
      for (const _ of Array.from({ length: 32 })) {
        const step = yield* replacementClient.action(id, { op: "vm.reclaim", limit: 1000 });
        resumed.push(step);
        if (step.status !== "pending") break;
      }
      const final = resumed.at(-1);
      if (final === undefined) return yield* Effect.die("No native collection result");
      if (fixture !== null) {
        if (
          final.status !== "complete" ||
          first.removed + resumed.reduce((total, step) => total + step.removed, 0) <
            fixture.files ||
          resumed.some((step) => step.removed > 1000)
        )
          return yield* Effect.die(
            "Native fixture reclamation did not complete its required batches",
          );
        const read = yield* fixture.manager
          .action(id, { op: "filesystem.readFile", path: "/proof-0000" })
          .pipe(Effect.result);
        if (
          read._tag !== "Failure" ||
          read.failure._tag !== "BoxesError" ||
          read.failure.status !== 404
        )
          return yield* Effect.die("Collected sandbox remained readable");
      }
      const refused = yield* admin
        .mintCapability(id, { permissions: ["read"], expiresInSeconds: 60 })
        .pipe(Effect.result);
      if (
        refused._tag !== "Failure" ||
        refused.failure._tag !== "BoxesError" ||
        refused.failure.status !== 403
      )
        return yield* Effect.die("Disposed sandbox accepted new read authority");
      const recreate = yield* admin.create({ id, policy }).pipe(Effect.result);
      if (
        recreate._tag !== "Failure" ||
        recreate.failure._tag !== "BoxesError" ||
        recreate.failure.status !== 409
      )
        return yield* Effect.die("Collected sandbox ID could be recreated");
      const result = {
        measuredAt: yield* Clock.currentTimeMillis,
        profile,
        targetWorker,
        sandboxId: id,
        previewOrigins: [session.url, replacement.url],
        consumerBundleSha256,
        first,
        resumed,
        recreateDenied: 409 as const,
        nonManagementGrantDenied: 403 as const,
        status: final.status,
      };
      if (fixture === null || denials === null) return { ...result, kind: "existing" as const };
      return {
        ...result,
        kind: "fixture" as const,
        files: fixture.files,
        writes: fixture.writes,
        verifiedContents: 3 as const,
        ...denials,
        readDenied: 404 as const,
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
