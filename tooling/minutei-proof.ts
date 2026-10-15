import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { Config, Effect, Schema } from "effect";
import { Runtime, PlatformProxy } from "@alchemy.run/cloudflare-runtime/core";
import {
  DurableObjectNamespace,
  Json,
  KvNamespace,
  Queue,
  R2Bucket,
  Service,
  Text,
} from "@alchemy.run/cloudflare-runtime/core/bindings";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http";

const [consumerRoot, archive, registry] = Schema.decodeUnknownSync(
  Schema.Union([
    Schema.Tuple([Schema.NonEmptyString, Schema.NonEmptyString]),
    Schema.Tuple([Schema.NonEmptyString, Schema.NonEmptyString, Schema.NonEmptyString]),
  ]),
)(Bun.argv.slice(2));
const Package = Schema.Struct({ name: Schema.String, version: Schema.String });
const Report = Schema.Struct({
  clientVersion: Schema.String,
  runtimeVersion: Schema.String,
  runtimeArchiveSha256: Schema.String,
  consumerCommit: Schema.String,
  consumerBundleSha256: Schema.String,
  transport: Schema.String,
  retention: Schema.Boolean,
  isolatedRegistry: Schema.Boolean,
  capabilities: Schema.Boolean,
  consumerFixturesSha256: Schema.Record(Schema.String, Schema.String),
});

if (registry === undefined) {
  process.exitCode = await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const directory = yield* Effect.acquireRelease(
          Effect.promise(() => mkdtemp(join(tmpdir(), "boxes-minutei-registry-"))),
          (path) => Effect.promise(() => rm(path, { recursive: true, force: true })),
        );
        const child = yield* Effect.acquireRelease(
          Effect.sync(() =>
            Bun.spawn([process.execPath, import.meta.path, consumerRoot, archive, directory], {
              env: { ...Bun.env, XDG_STATE_HOME: directory },
              stdout: "inherit",
              stderr: "inherit",
            }),
          ),
          (child) =>
            Effect.promise(async () => {
              if (child.exitCode === null) child.kill();
              await child.exited;
            }),
        );
        return yield* Effect.promise(() => child.exited);
      }),
    ),
  );
} else {
  const configuredRegistry = await Effect.runPromise(
    Effect.gen(function* () {
      return yield* Config.String("XDG_STATE_HOME");
    }),
  );
  if (configuredRegistry !== registry) process.exit(1);
  const report = await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const directory = yield* Effect.acquireRelease(
          Effect.promise(() => mkdtemp(join(tmpdir(), "boxes-minutei-proof-"))),
          (path) => Effect.promise(() => rm(path, { recursive: true, force: true })),
        );
        const consumer = resolve(consumerRoot);
        const artifact = join(directory, "runtime");
        yield* Effect.promise(() => mkdir(artifact));
        yield* Effect.sync(() =>
          execFileSync("tar", ["-xzf", resolve(archive), "-C", artifact, "--strip-components=1"]),
        );
        const runtimePackage = yield* Schema.decodeUnknownEffect(Package)(
          yield* Effect.promise(() => Bun.file(join(artifact, "package.json")).json()),
        );
        const clientPackage = yield* Schema.decodeUnknownEffect(Package)(
          yield* Effect.promise(() =>
            Bun.file(join(consumer, "apps/web/node_modules/@minutei-ai/boxes/package.json")).json(),
          ),
        );
        if (
          runtimePackage.name !== "@minutei-ai/boxes-runtime" ||
          clientPackage.name !== "@minutei-ai/boxes"
        )
          return yield* Effect.die("Unexpected consumer/runtime package identity");
        const initialCommit = yield* Effect.sync(() =>
          execFileSync("git", ["rev-parse", "HEAD"], { cwd: consumer, encoding: "utf8" }).trim(),
        );
        yield* Effect.sync(() =>
          execFileSync(
            "bun",
            [
              join(consumer, "apps/web/__tests__/fixtures/build-tenant-lifecycle.ts"),
              directory,
              "boxes-code.worker.ts",
            ],
            { cwd: consumer, stdio: "inherit" },
          ),
        );
        const callerSource = yield* Effect.promise(() =>
          readFile(join(directory, "boxes-code.worker.js"), "utf8"),
        );
        const files = yield* Effect.promise(() => readdir(artifact));
        const modules = [
          {
            name: "index.js",
            type: "ESModule" as const,
            content: yield* Effect.promise(() => readFile(join(artifact, "index.js"), "utf8")),
          },
          ...(yield* Effect.forEach(
            files.filter((file) => file.endsWith(".wasm")),
            (file) =>
              Effect.promise(() => readFile(join(artifact, file))).pipe(
                Effect.map((content) => ({ name: file, type: "Wasm" as const, content })),
              ),
          )),
        ];
        const name = basename(directory);
        const bindings = [
          Effect.gen(function* () {
            const runtime = yield* Runtime;
            yield* runtime.start({
              name,
              compatibilityDate: "2026-08-01",
              compatibilityFlags: ["nodejs_compat", "enable_request_signal"],
              modules,
              queueConsumers: [{ queueName: name, maxBatchSize: 1, maxBatchTimeout: 0 }],
              bindings: [
                R2Bucket.local({ binding: "OBJECTS", id: name }),
                Text.local("API_KEY", "minutei-boxes-local"),
                Queue.local({ binding: "EVENTS", queueName: name, deliveryDelay: 86400 }),
              ],
            });
            const url = yield* runtime.start({
              name: `${name}-caller`,
              durableObjectNamespaces: [{ className: "TenantWorkspace", sql: true }],
              compatibilityDate: "2026-08-01",
              compatibilityFlags: ["nodejs_compat", "enable_request_signal"],
              bindings: [
                Service.local({ binding: "BOXES", scriptName: name, entrypoint: "Agent" }),
                Queue.local({ binding: "BOXES_EVENTS", queueName: name }),
                Text.local("BOXES_API_KEY", "minutei-boxes-local"),
                Queue.local({ binding: "HISTORY_QUEUE", queueName: `${name}-history` }),
                DurableObjectNamespace.local({
                  binding: "TENANT_WORKSPACE",
                  className: "TenantWorkspace",
                }),
                KvNamespace.local({ binding: "WORKSPACE_KV", id: `${name}-workspace` }),
                R2Bucket.local({ binding: "BOXES_CODE_OBJECTS", id: name }),
                KvNamespace.local({ binding: "BOXES_CODE_RECORDS", id: name }),
              ],
              modules: [
                {
                  name: "index.js",
                  type: "ESModule",
                  content: callerSource,
                },
              ],
            });
            return yield* Json.local("ORIGIN", url.href);
          }).pipe(Effect.orDie),
        ];
        const proxy = yield* Effect.acquireRelease(
          Effect.promise(() =>
            PlatformProxy.getPlatformProxy<{ ORIGIN: string }, typeof bindings>({
              name: `${name}-proxy`,
              bindings,
              persist: { directory: join(directory, "state") },
            }),
          ),
          (value) => Effect.promise(() => value.dispose()),
        );
        const http = yield* HttpClient.HttpClient;
        yield* Effect.forEach(["retention", "capabilities"], (path) =>
          Effect.gen(function* () {
            const response = yield* http.execute(
              HttpClientRequest.get(new URL(`/${path}`, proxy.env.ORIGIN)),
            );
            const body = yield* response.text;
            if (response.status !== 204)
              return yield* Effect.die(`Minutei ${path} failed (${response.status}): ${body}`);
          }),
        );
        const fixtures = yield* Effect.forEach(
          ["boxes-retention.ts", "boxes-code.worker.ts"],
          (file) =>
            Effect.promise(
              async () =>
                [
                  file,
                  new Bun.CryptoHasher("sha256")
                    .update(
                      await Bun.file(
                        join(consumer, "apps/web/__tests__/fixtures", file),
                      ).arrayBuffer(),
                    )
                    .digest("hex"),
                ] as const,
            ),
        );
        const registrations = yield* Effect.promise(() =>
          readdir(join(configuredRegistry, "alchemy/registry")),
        );
        if (
          !registrations.includes(`${name}.json`) ||
          !registrations.includes(`${name}-caller.json`)
        )
          return yield* Effect.die(
            "Proof workers were not registered inside their isolated state directory",
          );
        const hash = yield* Effect.promise(async () =>
          new Bun.CryptoHasher("sha256")
            .update(await Bun.file(archive).arrayBuffer())
            .digest("hex"),
        );
        const commit = yield* Effect.sync(() =>
          execFileSync("git", ["rev-parse", "HEAD"], { cwd: consumer, encoding: "utf8" }).trim(),
        );
        if (commit !== initialCommit)
          return yield* Effect.die("Consumer HEAD changed during the proof");
        return {
          consumerBundleSha256: new Bun.CryptoHasher("sha256").update(callerSource).digest("hex"),
          clientVersion: clientPackage.version,
          runtimeVersion: runtimePackage.version,
          runtimeArchiveSha256: hash,
          consumerCommit: commit,
          transport:
            "native workerd Agent service binding; actual Minutei Code Mode and tenant SQLite; local R2, KV and Queue",
          retention: true,
          isolatedRegistry: true,
          capabilities: true,
          consumerFixturesSha256: Object.fromEntries(fixtures),
        };
      }),
    ).pipe(Effect.provide(FetchHttpClient.layer)),
  );
  console.log(Schema.encodeSync(Schema.fromJsonString(Report))(report));
}
