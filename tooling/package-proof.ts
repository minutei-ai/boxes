import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { Effect, Schema } from "effect";
import { Runtime, PlatformProxy } from "@alchemy.run/cloudflare-runtime/core";
import {
  Json,
  Queue,
  R2Bucket,
  Service,
  Text,
} from "@alchemy.run/cloudflare-runtime/core/bindings";
import { Id } from "../src/contracts";
import {
  BindingProof,
  DriverProof,
  PersistentDriverProof,
  RpcProbe,
} from "../tests/fixtures/sdk-binding-worker";

const Package = Schema.Struct({
  name: Schema.String,
  version: Schema.String,
  license: Schema.Literal("Apache-2.0"),
});
const Endpoints = Schema.Struct({ ORIGIN: Schema.String });
const archives = Schema.decodeUnknownSync(Schema.Tuple([Schema.String, Schema.String]))(
  Bun.argv.slice(2),
);

await Effect.runPromise(
  Effect.scoped(
    Effect.gen(function* () {
      const directory = yield* Effect.acquireRelease(
        Effect.promise(() => mkdtemp(join(tmpdir(), "boxes-package-proof-"))),
        (path) => Effect.promise(() => rm(path, { recursive: true, force: true })),
      );
      for (const [archive, name] of [
        [archives[0], "boxes"],
        [archives[1], "boxes-runtime"],
      ] as const) {
        const target = join(directory, "node_modules/@minutei-ai", name);
        yield* Effect.promise(() => mkdir(target, { recursive: true }));
        yield* Effect.sync(() =>
          execFileSync("tar", ["-xzf", resolve(archive), "-C", target, "--strip-components=1"]),
        );
      }
      for (const dependency of [
        "effect",
        "@tanstack/ai-code-mode",
        "@cloudflare/workers-types",
        "@types/bun",
      ] as const) {
        const target = join(directory, "node_modules", dependency);
        yield* Effect.promise(() => mkdir(dirname(target), { recursive: true }));
        yield* Effect.promise(() => symlink(resolve("node_modules", dependency), target));
      }
      const sdk = yield* Schema.decodeUnknownEffect(Package)(
        yield* Effect.promise(() =>
          Bun.file(join(directory, "node_modules/@minutei-ai/boxes/package.json")).json(),
        ),
      );
      const runtimePackage = yield* Schema.decodeUnknownEffect(Package)(
        yield* Effect.promise(() =>
          Bun.file(join(directory, "node_modules/@minutei-ai/boxes-runtime/package.json")).json(),
        ),
      );
      if (
        sdk.name !== "@minutei-ai/boxes" ||
        runtimePackage.name !== "@minutei-ai/boxes-runtime" ||
        sdk.version !== runtimePackage.version
      )
        return yield* Effect.die("SDK and runtime package identities differ");
      const fixture = (yield* Effect.promise(() =>
        readFile("tests/fixtures/sdk-binding-worker.ts", "utf8"),
      ))
        .replaceAll('"../../src/sdk"', '"@minutei-ai/boxes"')
        .replaceAll('"../../src/sdk-rpc"', '"@minutei-ai/boxes/rpc"')
        .replaceAll('"../../src/sdk-tanstack"', '"@minutei-ai/boxes/tanstack"')
        .replaceAll('"../../src/contracts"', '"@minutei-ai/boxes/contracts"')
        .replaceAll('"../../src/rpc-protocol"', '"@minutei-ai/boxes/rpc"');
      const entry = join(directory, "consumer.ts");
      yield* Effect.promise(() => writeFile(entry, fixture));
      yield* Effect.promise(() =>
        writeFile(
          join(directory, "tsconfig.json"),
          JSON.stringify({
            compilerOptions: {
              target: "ESNext",
              module: "ESNext",
              moduleResolution: "Bundler",
              strict: true,
              skipLibCheck: true,
              noEmit: true,
              types: ["@cloudflare/workers-types", "bun"],
            },
            include: ["consumer.ts"],
          }),
        ),
      );
      yield* Effect.sync(() =>
        execFileSync(
          "bun",
          [
            resolve("node_modules/typescript/bin/tsc"),
            "--project",
            join(directory, "tsconfig.json"),
          ],
          { stdio: "inherit" },
        ),
      );
      const bundle = yield* Effect.promise(() =>
        Bun.build({
          entrypoints: [entry],
          target: "browser",
          format: "esm",
          external: ["cloudflare:workers"],
        }),
      );
      if (!bundle.success) return yield* Effect.die(bundle.logs);
      const consumer = yield* Effect.promise(() => bundle.outputs[0].text());
      const artifact = dirname(Bun.resolveSync("@minutei-ai/boxes-runtime/worker", directory));
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
            compatibilityDate: "2026-10-06",
            compatibilityFlags: ["nodejs_compat", "enable_request_signal"],
            modules,
            queueConsumers: [
              { queueName: name, maxBatchSize: 1, maxBatchTimeout: 0, maxRetries: 100 },
            ],
            bindings: [
              R2Bucket.local({ binding: "OBJECTS", id: name }),
              Text.local("API_KEY", "cirro-local-test-credential"),
              Queue.local({ binding: "EVENTS", queueName: name, deliveryDelay: 86400 }),
            ],
          });
          const origin = yield* runtime.start({
            name: `${name}-consumer`,
            compatibilityDate: "2026-10-06",
            compatibilityFlags: ["nodejs_compat", "enable_request_signal"],
            bindings: [
              Service.local({ binding: "BOXES", scriptName: name }),
              Service.local({ binding: "BOXES_AGENT", scriptName: name, entrypoint: "Agent" }),
              Text.local("TOKEN", "cirro-local-test-credential"),
            ],
            modules: [{ name: "index.js", type: "ESModule", content: consumer }],
          });
          return yield* Json.local("ORIGIN", origin.href);
        }).pipe(Effect.orDie),
      ];
      const proxy = yield* Effect.acquireRelease(
        Effect.tryPromise(() =>
          PlatformProxy.getPlatformProxy<typeof Endpoints.Type, typeof bindings>({
            name: `${name}-proxy`,
            persist: { directory: join(directory, "state") },
            bindings,
          }),
        ),
        (value) => Effect.promise(() => value.dispose()),
      );
      const request = Effect.fn("packageProof.request")(function* (query: string, id: string) {
        const response = yield* Effect.promise(() =>
          fetch(new URL(query, proxy.env.ORIGIN), {
            method: "POST",
            body: Schema.encodeSync(Schema.fromJsonString(Id))(id),
          }),
        );
        if (response.status !== 200)
          return yield* Effect.die({
            status: response.status,
            body: yield* Effect.promise(() => response.text()),
          });
        return yield* Effect.promise(() => response.json());
      });
      const binding = yield* Schema.decodeUnknownEffect(BindingProof)(
        yield* request("/", "package-binding"),
      );
      if (
        binding.run.output?.result !== 42 ||
        binding.denied !== 401 ||
        binding.rpc.status !== "exited" ||
        binding.hostCalls.length !== 2 ||
        binding.reclaimed.status !== "complete" ||
        binding.restoredStat.inode <= binding.stat.inode
      )
        return yield* Effect.die("Packaged binding proof mismatch");
      const ephemeral = yield* Schema.decodeUnknownEffect(DriverProof)(
        yield* request("/?driver=true", "package-ephemeral"),
      );
      if (!ephemeral.closed || !ephemeral.voidResult || ephemeral.writes.length !== 1)
        return yield* Effect.die("Packaged ephemeral driver proof mismatch");
      const collected = yield* Schema.decodeUnknownEffect(Schema.Literal(1024))(
        yield* request("/?driver=bulk", "package-ephemeral-bulk"),
      );
      const rpc = yield* Schema.decodeUnknownEffect(RpcProbe)(
        yield* request("/?rpc=hardlinks", "package-hardlinks"),
      );
      yield* Schema.decodeUnknownEffect(
        Schema.Struct({
          same: Schema.Literal(true),
          links: Schema.Literal(2),
          content: Schema.Literal("YmluZGluZw=="),
          callback: Schema.Literal("callback"),
        }),
      )(rpc.record?.output?.result);
      if (rpc.calls !== 1) return yield* Effect.die("Packaged RPC callback count mismatch");
      const disposed = yield* Schema.decodeUnknownEffect(RpcProbe)(
        yield* request("/?rpc=disposal", "package-disposal"),
      );
      if (
        disposed.calls !== 1 ||
        disposed.record?.status !== "cancelled" ||
        (disposed.record.output !== null && disposed.record.output.result !== null)
      )
        return yield* Effect.die("Packaged RPC disposal did not cancel the admitted guest");
      for (const phase of ["create", "read"] as const) {
        const persistent = yield* Schema.decodeUnknownEffect(PersistentDriverProof)(
          yield* request(`/?persistent=${phase}`, "package-persistent"),
        );
        if (
          !persistent.cancelled ||
          persistent.lateWrites.length !== 0 ||
          !persistent.writeDenied ||
          !persistent.lowMemoryRejected ||
          !persistent.sandboxLimitEnforced ||
          persistent.foreignStatus !== "queued" ||
          Buffer.from(persistent.file.content, persistent.file.encoding).toString() !== "confirmed"
        )
          return yield* Effect.die("Packaged persistent driver proof mismatch");
      }
      console.log(
        Schema.encodeSync(
          Schema.fromJsonString(
            Schema.Struct({
              version: Package.fields.version,
              transport: Schema.String,
              proof: Schema.String,
            }),
          ),
        )({
          version: sdk.version,
          transport: "native Alchemy workerd service binding and Agent RPC; local R2 and Queue",
          proof: `SDK archive exports and consumer declarations; runtime archive; filesystem snapshot restore; hard-link metadata; RPC callbacks and cooperative disposal; ephemeral context disposal with ${collected} files and concurrent closes; persistent driver contexts and cancellation; scoped authority`,
        }),
      );
    }),
  ).pipe(Effect.timeout("60 seconds")),
);
