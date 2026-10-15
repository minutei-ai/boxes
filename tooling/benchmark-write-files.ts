import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { Clock, Effect, Redacted, Schema } from "effect";
import { FetchHttpClient } from "effect/http";
import { Runtime, PlatformProxy } from "@alchemy.run/cloudflare-runtime/core";
import { R2Bucket, Queue, Text, Json } from "@alchemy.run/cloudflare-runtime/core/bindings";
import { make } from "../src/sdk";
const arguments_ = Schema.decodeUnknownSync(
  Schema.Union([
    Schema.Tuple([Schema.NonEmptyString, Schema.NonEmptyString, Schema.NonEmptyString]),
    Schema.Tuple([
      Schema.NonEmptyString,
      Schema.NonEmptyString,
      Schema.NonEmptyString,
      Schema.Literal("--reference-only"),
    ]),
  ]),
)(Bun.argv.slice(2));
const [reference, current, destination] = arguments_;
const order = [
  "reference",
  "current",
  "current",
  "reference",
  "current",
  "reference",
  "reference",
  "current",
] as const;
const phasesToRun = order.filter((_, index) => arguments_.length === 3 || index === 0);
const Report = Schema.Struct({
  measuredAt: Schema.String,
  environment: Schema.String,
  workload: Schema.String,
  phases: Schema.Array(
    Schema.Struct({
      version: Schema.Literals(["reference", "current"]),
      phase: Schema.Int,
      warmups: Schema.Int,
      samplesMs: Schema.Array(Schema.Number),
      p50Ms: Schema.Number,
      p95Ms: Schema.Number,
    }),
  ),
});
const phases = await Effect.runPromise(
  Effect.scoped(
    Effect.gen(function* () {
      return yield* Effect.forEach(
        phasesToRun,
        (version, phase) =>
          Effect.scoped(
            Effect.gen(function* () {
              const directory = yield* Effect.acquireRelease(
                Effect.promise(() => mkdtemp(join(tmpdir(), "boxes-write-batch-abba-"))),
                (path) => Effect.promise(() => rm(path, { recursive: true, force: true })),
              );
              const artifact = { reference, current }[version];
              const files = yield* Effect.promise(() => readdir(artifact));
              const modules = [
                {
                  name: "index.js",
                  type: "ESModule" as const,
                  content: yield* Effect.promise(() =>
                    readFile(join(artifact, "index.js"), "utf8"),
                  ),
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
                  const url = yield* runtime.start({
                    name,
                    compatibilityDate: "2026-10-06",
                    compatibilityFlags: ["nodejs_compat", "enable_request_signal"],
                    modules,
                    bindings: [
                      R2Bucket.local({ binding: "OBJECTS", id: name }),
                      Text.local("API_KEY", "cirro-local-test-credential"),
                      Queue.local({ binding: "EVENTS", queueName: name, deliveryDelay: 86400 }),
                    ],
                  });
                  return yield* Json.local("URL", url.href);
                }).pipe(Effect.orDie),
              ];
              const proxy = yield* Effect.acquireRelease(
                Effect.promise(() =>
                  PlatformProxy.getPlatformProxy<{ URL: string }, typeof bindings>({
                    name: `${name}-proxy`,
                    bindings,
                    persist: { directory: join(directory, "state") },
                  }),
                ),
                (value) => Effect.promise(() => value.dispose()),
              );
              const admin = yield* make({
                url: proxy.env.URL,
                token: Redacted.make("cirro-local-test-credential"),
              });
              yield* admin.create({
                id: "bench",
                environment: {},
                policy: {
                  networkHosts: [],
                  interruptBudget: 1000,
                  memoryBytes: 8388608,
                  maxOutputBytes: 1048576,
                },
              });
              const grant = yield* admin.mintCapability("bench", {
                permissions: ["read", "write", "execute"],
                expiresInSeconds: 600,
              });
              const client = yield* make({ url: proxy.env.URL, token: Redacted.make(grant.token) });
              const times: number[] = [];
              yield* Effect.forEach(
                Array.from({ length: 16 }, (_, index) => index),
                (index) =>
                  Effect.gen(function* () {
                    const entries = Array.from({ length: 128 }, (_, file) => ({
                      path: `/tmp/sample-${index}/file-${file}`,
                      content: `payload-${index}-${file}`,
                      encoding: "utf8" as const,
                    }));
                    const start = yield* Clock.monotonicTimeNanos;
                    const written = yield* client.action("bench", {
                      op: "filesystem.writeFiles",
                      entries,
                    });
                    const elapsed = Number((yield* Clock.monotonicTimeNanos) - start) / 1000000;
                    if (
                      written.length !== 128 ||
                      written.some(
                        (entry, file) => !entry.success || entry.path !== entries[file].path,
                      )
                    )
                      return yield* Effect.die("Invalid benchmark batch result");
                    const samples = [entries[0], entries[63], entries[127]];
                    const read = yield* client.action("bench", {
                      op: "filesystem.readFiles",
                      paths: samples.map((file) => file.path),
                    });
                    if (
                      read.length !== samples.length ||
                      read.some(
                        (entry, file) =>
                          entry.content !== Buffer.from(samples[file].content).toString("base64"),
                      )
                    )
                      return yield* Effect.die("Benchmark content verification failed");
                    if (index >= 4) times.push(elapsed);
                  }),
              );
              console.error({ phase, version, stage: "completed", samples: times.length });
              const sorted = times.toSorted((a, b) => a - b);
              return {
                version,
                phase,
                warmups: 4,
                samplesMs: times,
                p50Ms: sorted[5],
                p95Ms: sorted[11],
              };
            }),
          ),
        { concurrency: 1 },
      );
    }),
  ).pipe(Effect.provide(FetchHttpClient.layer)),
);
await Bun.write(
  destination,
  Schema.encodeSync(Schema.fromJsonString(Report))({
    measuredAt: new Date().toISOString(),
    environment:
      "local native Alchemy workerd; runtime module directories; fresh R2 per phase; sequential ABBA then BAAB",
    workload:
      "128 new files with distinct small contents per request; four warmups and twelve timed samples per phase; ordered acknowledgements and three sampled contents verified; nearest-rank quantiles",
    phases,
  }) + "\n",
);
