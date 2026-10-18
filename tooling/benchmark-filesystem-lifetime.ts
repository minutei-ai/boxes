import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Clock, Effect, Redacted, Schema, Struct } from "effect";
import { Runtime, PlatformProxy } from "@alchemy.run/cloudflare-runtime/core";
import {
  Json,
  Queue,
  R2Bucket,
  Service,
  Text,
} from "@alchemy.run/cloudflare-runtime/core/bindings";
import { BINDING_PLATFORM_PROXY_TOKEN } from "@alchemy.run/cloudflare-runtime/core/platform-proxy/PlatformProxyProtocol";
import type { Control } from "../tests/fixtures/clock-worker";
import { FilesystemUsage } from "../tests/fixtures/filesystem-lifetime-contract";
import { makeBinding } from "../src/sdk";
import { RunRecord } from "../src/contracts";

const [reference, current, destination] = Schema.decodeUnknownSync(
  Schema.Tuple([Schema.NonEmptyString, Schema.NonEmptyString, Schema.NonEmptyString]),
)(Bun.argv.slice(2));
const Variant = Schema.Literals(["reference", "current"]);
const Sample = FilesystemUsage.mapFields((fields) => Struct.omit(fields, ["status", "body"]));
const Phase = Schema.Struct({
  phase: Schema.Int,
  variant: Variant,
  warmups: Schema.Array(Sample),
  samples: Schema.Array(Sample),
});
const Asset = Schema.Struct({ file: Schema.String, bytes: Schema.Int, sha256: Schema.String });
const Report = Schema.Struct({
  measuredAt: Schema.Int,
  environment: Schema.String,
  workload: Schema.String,
  scope: Schema.String,
  artifacts: Schema.Record(Variant, Schema.Array(Asset)),
  phases: Schema.Array(Phase),
});
const report = await Effect.runPromise(
  Effect.scoped(
    Effect.gen(function* () {
      const artifacts = yield* Effect.forEach(["reference", "current"] as const, (variant) =>
        Effect.gen(function* () {
          const directory = { reference, current }[variant];
          const files = yield* Effect.promise(() => readdir(directory));
          const assets = yield* Effect.forEach(
            files.filter((file) => file === "index.js" || file.endsWith(".wasm")).sort(),
            (file) =>
              Effect.gen(function* () {
                const bytes = yield* Effect.promise(() => readFile(join(directory, file)));
                return {
                  file,
                  bytes: bytes.byteLength,
                  sha256: new Bun.CryptoHasher("sha256").update(bytes).digest("hex"),
                };
              }),
          );
          return assets;
        }),
      );
      const referenceAssets = artifacts[0];
      const currentAssets = artifacts[1];
      if (
        referenceAssets === undefined ||
        currentAssets === undefined ||
        referenceAssets.length !== 6 ||
        currentAssets.length !== 6
      )
        return yield* Effect.die(
          "Expected both instrumented fixture builds and five native modules",
        );
      for (const asset of referenceAssets.filter((asset) => asset.file.endsWith(".wasm"))) {
        const match = currentAssets.find((candidate) => candidate.file === asset.file);
        if (match?.sha256 !== asset.sha256)
          return yield* Effect.die(
            "Only the filesystem Effect lifetime may change; native binaries must match",
          );
      }
      const phases = yield* Effect.forEach(
        [
          "reference",
          "current",
          "current",
          "reference",
          "current",
          "reference",
          "reference",
          "current",
        ] as const,
        (variant, phase) =>
          Effect.scoped(
            Effect.gen(function* () {
              const directory = yield* Effect.acquireRelease(
                Effect.promise(() => mkdtemp(join(tmpdir(), "boxes-filesystem-lifetime-abba-"))),
                (path) => Effect.promise(() => rm(path, { recursive: true, force: true })),
              );
              const name = `filesystem-lifetime-${crypto.randomUUID()}`;
              const artifact = { reference, current }[variant];
              const modules = [
                {
                  name: "index.js",
                  type: "ESModule" as const,
                  content: yield* Effect.promise(() =>
                    readFile(join(artifact, "index.js"), "utf8"),
                  ),
                },
                ...(yield* Effect.forEach(
                  referenceAssets.filter((asset) => asset.file.endsWith(".wasm")),
                  (asset) =>
                    Effect.promise(() => readFile(join(artifact, asset.file))).pipe(
                      Effect.map((content) => ({
                        name: asset.file,
                        type: "Wasm" as const,
                        content,
                      })),
                    ),
                )),
              ];
              const bindings = [
                Effect.gen(function* () {
                  const runtime = yield* Runtime;
                  yield* runtime.start({
                    name,
                    compatibilityDate: "2026-10-06",
                    compatibilityFlags: [
                      "nodejs_compat",
                      "enable_request_signal",
                      "experimental",
                      "service_binding_extra_handlers",
                    ],
                    modules,
                    bindings: [
                      R2Bucket.local({ binding: "OBJECTS", id: name }),
                      Text.local("API_KEY", "filesystem-lifetime-benchmark"),
                      Text.local(BINDING_PLATFORM_PROXY_TOKEN, crypto.randomUUID()),
                      Json.local("SOFTWARE_BASE", null),
                      Json.local("CLOCK_START", yield* Clock.currentTimeMillis),
                      Json.local("CLOCK_ADVANCE", 0),
                      Json.local("CLOCK_ADVANCE_AFTER_OUTPUT", null),
                      Json.local("CLOCK_CONTROLLED", false),
                      Queue.local({ binding: "EVENTS", queueName: name, deliveryDelay: 86400 }),
                      Service.self("SELF"),
                    ],
                  });
                  return yield* Service.local({ binding: "BOXES", scriptName: name });
                }).pipe(Effect.orDie),
                Service.local({ binding: "CONTROL", scriptName: name, entrypoint: "Control" }),
              ];
              const proxy = yield* Effect.acquireRelease(
                Effect.tryPromise(() =>
                  PlatformProxy.getPlatformProxy<
                    { BOXES: Fetcher; CONTROL: Fetcher<Control> },
                    typeof bindings
                  >({ name: `${name}-proxy`, bindings, persist: { directory } }),
                ),
                (value) => Effect.promise(() => value.dispose()),
              );
              const admin = yield* makeBinding(
                proxy.env.BOXES,
                Redacted.make("filesystem-lifetime-benchmark"),
              );
              yield* admin.create({
                id: "benchmark",
                policy: {
                  networkHosts: [],
                  interruptBudget: 100000,
                  memoryBytes: 16777216,
                  maxOutputBytes: 1048576,
                },
              });
              const grant = yield* admin.mintCapability("benchmark", {
                permissions: ["read", "write", "execute"],
                expiresInSeconds: 600,
              });
              const client = yield* makeBinding(proxy.env.BOXES, Redacted.make(grant.token));
              for (const batch of [0, 1, 2, 3, 4, 5, 6, 7])
                yield* client.action("benchmark", {
                  op: "filesystem.writeFiles",
                  entries: Array.from({ length: 128 }, (_, index) => ({
                    path: `/tmp/data/file-${batch * 128 + index}`,
                    content: "x",
                    encoding: "utf8" as const,
                  })),
                });
              const measurements = yield* Effect.forEach(
                [0, 1, 2, 3, 4, 5, 6],
                (index) =>
                  Effect.gen(function* () {
                    const value = yield* Effect.promise(() =>
                      proxy.env.CONTROL.pythonFilesystemUsage("benchmark", grant.token, {
                        op: "python.execute",
                        id: `metadata-${index}`,
                        source:
                          "import os\nsum(os.stat('/tmp/data/file-0').st_size for _ in range(64))",
                      }),
                    );
                    if (value.status !== 200) return yield* Effect.die(value);
                    const record = yield* Schema.decodeUnknownEffect(
                      Schema.fromJsonString(RunRecord),
                    )(value.body);
                    if (
                      record.output?.exitCode !== 0 ||
                      record.output.result !== 64 ||
                      value.counts.headPuts !== 0 ||
                      value.counts.fullHeadBodies !== 66
                    )
                      return yield* Effect.die({ value, record });
                    return {
                      elapsedMs: value.elapsedMs,
                      kernelMemoryBefore: value.kernelMemoryBefore,
                      kernelMemoryAfter: value.kernelMemoryAfter,
                      counts: value.counts,
                    };
                  }),
                { concurrency: 1 },
              );
              yield* Effect.logInfo({
                phase,
                variant,
                samples: measurements.length - 2,
                peakKernelBytes: Math.max(...measurements.map((value) => value.kernelMemoryAfter)),
              });
              return {
                phase,
                variant,
                warmups: measurements.slice(0, 2),
                samples: measurements.slice(2),
              };
            }),
          ),
        { concurrency: 1 },
      );
      return {
        measuredAt: yield* Clock.currentTimeMillis,
        environment: `Bun ${Bun.version}; native Alchemy workerd and local R2; fresh Worker/R2 per phase; ABBA then BAAB`,
        workload:
          "1,024 one-byte files; 64 Python absolute pathname stats per request; two warmups and five timed samples per phase; every output and unchanged full-head-read count validated",
        scope:
          "Counter forwards actual native R2 operations. Kernel memory is linear-memory capacity high-water, not RSS, live allocations, total Worker memory or Python heap. Worker-clock request elapsed time excludes setup, startup and RPC transport; this is not production latency, CPU or billing.",
        artifacts: { reference: referenceAssets, current: currentAssets },
        phases,
      };
    }),
  ),
);
await Bun.write(destination, Schema.encodeSync(Schema.fromJsonString(Report))(report));
console.log(
  JSON.stringify({
    output: destination,
    phases: report.phases.map((phase) => ({
      phase: phase.phase,
      variant: phase.variant,
      elapsedMs: phase.samples.map((sample) => sample.elapsedMs),
      peakKernelBytes: Math.max(...phase.samples.map((sample) => sample.kernelMemoryAfter)),
    })),
  }),
);
