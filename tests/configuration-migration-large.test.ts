import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Redacted, Schema } from "effect";
import { FetchHttpClient } from "effect/http";
import {
  EnvironmentMigrationInput,
  EnvironmentMigrationReceipt,
  StoredRun,
  StoredRunMetadata,
} from "../src/contracts";
import { make } from "../src/sdk";
import { runtime } from "../tooling/worker-test";

test(
  "a complete native migration page reuses a large current archive without rewriting receipts or source",
  () =>
    Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const directory = yield* Effect.acquireRelease(
            Effect.promise(() => mkdtemp(join(tmpdir(), "boxes-migration-large-"))),
            (path) => Effect.promise(() => rm(path, { recursive: true, force: true })),
          );
          const worker = yield* Effect.acquireRelease(
            Effect.sync(() => runtime(directory)),
            (worker) => Effect.promise(() => worker.dispose()),
          );
          const url = (yield* Effect.promise(() => worker.ready)).toString();
          const admin = yield* make({ url, token: Redacted.make("cirro-local-test-credential") });
          const id = "large-migration";
          yield* admin.create({
            id,
            policy: {
              networkHosts: [],
              interruptBudget: 1000,
              memoryBytes: 8388608,
              maxOutputBytes: 1048576,
            },
          });
          const grant = yield* admin.mintCapability(id, {
            permissions: ["read", "execute"],
            expiresInSeconds: 600,
          });
          const client = yield* make({ url, token: Redacted.make(grant.token) });
          const bytes = Buffer.from(
            yield* Effect.promise(() => Bun.file("dist/wasi-large.wasm").arrayBuffer()),
          );
          expect(bytes.length).toBeGreaterThan(2097152);
          yield* client.action(id, {
            op: "process.run",
            id: "batch-00",
            language: "wasm",
            source: bytes.toString("base64"),
          });
          const bucket = yield* Effect.promise(() => worker.objects);
          const receipt = yield* Effect.promise(() => bucket.get(`processes/${id}/batch-00.json`));
          if (receipt === null) return yield* Effect.die("Missing real large-module receipt");
          const record = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(StoredRun))(
            yield* Effect.promise(() => receipt.text()),
          );
          const metadata = yield* Schema.decodeUnknownEffect(StoredRunMetadata)(
            receipt.customMetadata,
          );
          const codeKey = `sandboxes/${id}/code/${record.sourceHash}`;
          const code = yield* Effect.promise(() => bucket.head(codeKey));
          if (code === null) return yield* Effect.die("Missing large program archive");
          expect(code.size).toBeGreaterThan(2097152);
          for (const index of Array.from({ length: 24 }, (_, index) => index + 1)) {
            const processId = `batch-${index.toString().padStart(2, "0")}`;
            yield* Effect.promise(() =>
              bucket.put(
                `processes/${id}/${processId}.json`,
                Schema.encodeSync(Schema.fromJsonString(StoredRun))({ ...record, id: processId }),
                {
                  customMetadata: Schema.encodeSync(StoredRunMetadata)({
                    ...metadata,
                    summary: { ...metadata.summary, id: processId },
                  }),
                },
              ),
            );
          }
          for (const iteration of [0, 1]) {
            const response = yield* Effect.promise(() =>
              fetch(new URL("/v1/migrations/environment-v1", url), {
                method: "POST",
                headers: {
                  authorization: "Bearer cirro-local-test-credential",
                  "content-type": "application/json",
                },
                body: Schema.encodeSync(Schema.fromJsonString(EnvironmentMigrationInput))({
                  cursor: { phase: "processes", continuation: null },
                }),
                signal: AbortSignal.timeout(10000),
              }),
            );
            expect(response.status).toBe(200);
            const progress = yield* Schema.decodeUnknownEffect(
              Schema.fromJsonString(EnvironmentMigrationReceipt),
            )(yield* Effect.promise(() => response.text()));
            expect([iteration, progress.migrated, progress.cursor]).toEqual([iteration, 0, null]);
          }
          expect((yield* Effect.promise(() => bucket.head(codeKey)))?.etag).toBe(code.etag);
          expect(
            (yield* Effect.promise(() => bucket.head(`processes/${id}/batch-00.json`)))?.etag,
          ).toBe(receipt.etag);
        }),
      ).pipe(Effect.provide(FetchHttpClient.layer)),
    ),
  30000,
);
