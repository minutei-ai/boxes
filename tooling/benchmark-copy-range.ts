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
      const phases = yield* Effect.forEach(
        ["reference", "current", "current", "reference"] as const,
        (variant, phase) =>
          Effect.scoped(
            Effect.gen(function* () {
              const directory = yield* Effect.acquireRelease(
                Effect.promise(() => mkdtemp(join(tmpdir(), "boxes-copy-range-abba-"))),
                (path) => Effect.promise(() => rm(path, { recursive: true, force: true })),
              );
              const name = `copy-range-${crypto.randomUUID()}`;
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
                      Text.local("API_KEY", "copy-range-benchmark"),
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
                Redacted.make("copy-range-benchmark"),
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
              for (const offset of Array.from({ length: 16 }, (_, index) => index * 1048576)) {
                const content = Buffer.from(
                  Uint8Array.from({ length: 1048576 }, (_, index) => (offset + index) % 251),
                ).toString("base64");
                yield* client.action("benchmark", {
                  op: "filesystem.writeFile",
                  path: "/tmp/source",
                  offset,
                  content,
                  encoding: "base64",
                });
              }
              const measurements = yield* Effect.forEach(
                [0, 1, 2],
                (index) =>
                  Effect.gen(function* () {
                    const value = yield* Effect.promise(() =>
                      proxy.env.CONTROL.pythonFilesystemUsage("benchmark", grant.token, {
                        op: "python.execute",
                        id: `copy-${index}`,
                        source:
                          "from pathlib import Path\ncopied=Path('/tmp/source').copy('/tmp/copied')\nassert copied.stat().st_size==16777216\n42",
                      }),
                    );
                    if (value.status !== 200) return yield* Effect.die(value);
                    const record = yield* Schema.decodeUnknownEffect(
                      Schema.fromJsonString(RunRecord),
                    )(value.body);
                    if (record.output?.exitCode !== 0 || record.output.result !== 42)
                      return yield* Effect.die({ value, record });
                    const actual = new Bun.CryptoHasher("sha256");
                    const expected = new Bun.CryptoHasher("sha256");
                    for (const offset of Array.from(
                      { length: 16 },
                      (_, position) => position * 1048576,
                    )) {
                      const part = yield* client.action("benchmark", {
                        op: "filesystem.readFile",
                        path: "/tmp/copied",
                        offset,
                        length: 1048576,
                      });
                      const bytes = Buffer.from(part.content, "base64");
                      if (bytes.byteLength !== 1048576)
                        return yield* Effect.die("Incomplete full-file readback");
                      actual.update(bytes);
                      expected.update(
                        Uint8Array.from(
                          { length: 1048576 },
                          (_, position) => (offset + position) % 251,
                        ),
                      );
                    }
                    if (actual.digest("hex") !== expected.digest("hex"))
                      return yield* Effect.die("Copy digest mismatch");
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
                samples: measurements.length - 1,
                peakKernelBytes: Math.max(...measurements.map((value) => value.kernelMemoryAfter)),
              });
              return {
                phase,
                variant,
                warmups: measurements.slice(0, 1),
                samples: measurements.slice(1),
              };
            }),
          ),
        { concurrency: 1 },
      );
      return {
        measuredAt: yield* Clock.currentTimeMillis,
        environment: `Bun ${Bun.version}; native Alchemy workerd and local R2 without default software; fresh Worker/R2 per phase; ABBA`,
        workload:
          "16 MiB varying-byte pathlib copy; one warmup and two samples per phase; full readback SHA-256 after every sample; immutable-block and fallback runtimes recorded separately",
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
