import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { Effect, Redacted, Schema } from "effect";
import { FetchHttpClient } from "effect/http";
import { Runtime, PlatformProxy } from "@alchemy.run/cloudflare-runtime/core";
import { R2Bucket, Queue, Text, Json } from "@alchemy.run/cloudflare-runtime/core/bindings";
import { make } from "../src/sdk";
const [reference, current, destination] = Schema.decodeUnknownSync(
  Schema.Tuple([Schema.NonEmptyString, Schema.NonEmptyString, Schema.NonEmptyString]),
)(Bun.argv.slice(2));
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
        (version, phase) =>
          Effect.scoped(
            Effect.gen(function* () {
              const directory = yield* Effect.acquireRelease(
                Effect.promise(() => mkdtemp(join(tmpdir(), "boxes-variable-abba-"))),
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
                      Json.local("SOFTWARE_BASE", null),
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
                environment: Object.fromEntries([
                  ["A", "retained"],
                  ...Array.from({ length: 127 }, (_, index) => [`K${index}`, "x".repeat(440)]),
                ]),
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
                Array.from({ length: 35 }, (_, index) => index),
                (index) =>
                  Effect.gen(function* () {
                    const start = performance.now();
                    const result = yield* client.action("bench", {
                      op: "process.run",
                      id: `phase-${phase}-${index}`,
                      language: "shell",
                      source: 'echo "$A"; '.repeat(64) + "true",
                    });
                    const elapsed = performance.now() - start;
                    if (
                      result.output?.stdout !== "retained\n".repeat(64) ||
                      result.output.exitCode !== 0
                    )
                      return yield* Effect.die("Invalid benchmark result");
                    if (index >= 10) times.push(elapsed);
                  }),
              );
              const sorted = times.toSorted((a, b) => a - b);
              return {
                version,
                phase,
                warmups: 10,
                samplesMs: times,
                p50Ms: sorted[12],
                p95Ms: sorted[23],
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
    workload: 'echo "$A"; '.repeat(64) + "true",
    phases,
  }) + "\n",
);
