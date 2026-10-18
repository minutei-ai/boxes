import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Effect, Redacted, Schema } from "effect";
import { makeBinding } from "../src/sdk";
import { RunRecord } from "../src/contracts";
import { runtime } from "../tooling/worker-test";

test(
  "repeated Python pathname stats release native kernels within the filesystem action lifetime",
  () =>
    Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const directory = yield* Effect.acquireRelease(
            Effect.promise(() => mkdtemp(join(tmpdir(), "boxes-filesystem-lifetime-"))),
            (path) => Effect.promise(() => rm(path, { recursive: true, force: true })),
          );
          const worker = yield* Effect.acquireRelease(
            Effect.sync(() => runtime(directory, { controlled: false })),
            (worker) => Effect.promise(() => worker.dispose()),
          );
          const service = yield* Effect.promise(() => worker.service);
          const admin = yield* makeBinding(service, Redacted.make("cirro-local-test-credential"));
          yield* admin.create({
            id: "lifetime",
            policy: {
              networkHosts: [],
              interruptBudget: 100000,
              memoryBytes: 16777216,
              maxOutputBytes: 1048576,
            },
          });
          const grant = yield* admin.mintCapability("lifetime", {
            permissions: ["read", "write", "execute"],
            expiresInSeconds: 600,
          });
          const client = yield* makeBinding(service, Redacted.make(grant.token));
          for (const batch of [0, 1, 2, 3, 4, 5, 6, 7])
            yield* client.action("lifetime", {
              op: "filesystem.writeFiles",
              entries: Array.from({ length: 128 }, (_, index) => ({
                path: `/tmp/data/file-${batch * 128 + index}`,
                content: "x",
                encoding: "utf8" as const,
              })),
            });
          const control = yield* Effect.promise(() => worker.control);
          const proof = yield* Effect.promise(() =>
            control.pythonFilesystemUsage("lifetime", grant.token, {
              op: "python.execute",
              id: "metadata",
              source: "import os\nsum(os.stat('/tmp/data/file-0').st_size for _ in range(64))",
            }),
          );
          expect(proof.status).toBe(200);
          const record = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(RunRecord))(
            proof.body,
          );
          expect(record.output?.exitCode).toBe(0);
          expect(record.output?.result).toBe(64);
          expect(proof.counts.headPuts).toBe(0);
          expect(proof.counts.headGets).toBeGreaterThanOrEqual(64);
          expect(proof.counts.conditionalHeadGets).toBeGreaterThanOrEqual(2);
          expect(proof.kernelMemoryAfter).toBeLessThanOrEqual(8 * 1024 * 1024);
          const faults = yield* Effect.promise(() =>
            control.pythonFilesystemUsage("lifetime", grant.token, {
              op: "python.execute",
              id: "missing-metadata",
              source: `import os
caught=0
for _ in range(64):
 try:
  os.stat('/tmp/data/missing')
 except FileNotFoundError:
  caught+=1
caught`,
            }),
          );
          expect(faults.status).toBe(200);
          const failedLookups = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(RunRecord))(
            faults.body,
          );
          expect(failedLookups.output?.exitCode).toBe(0);
          expect(failedLookups.output?.result).toBe(64);
          expect(faults.counts.headPuts).toBe(0);
          expect(faults.kernelMemoryAfter).toBeLessThanOrEqual(8 * 1024 * 1024);
        }),
      ),
    ),
  60000,
);
