import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { Effect, Redacted, Result, Schema, Struct } from "effect";
import { FetchHttpClient } from "effect/http";
import { InputHead, InputMigrationInput, InputMigrationReceipt } from "../src/contracts";
import { make } from "../src/sdk";
import { runtime } from "../tooling/worker-test";

const PreviousInput = InputHead.mapFields((fields) => ({
  ...Struct.omit(fields, ["terminal", "attributes", "version"]),
  version: Schema.Literal(1),
}));
const GeometryInput = InputHead.mapFields((fields) => ({
  ...Struct.omit(fields, ["attributes", "version"]),
  version: Schema.Literal(2),
}));

test(
  "input terminal cutover converts both historical versions and preserves resized and configured state",
  () =>
    Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const directory = yield* Effect.acquireRelease(
            Effect.promise(() => mkdtemp("/tmp/boxes-input-migration-")),
            (path) => Effect.promise(() => rm(path, { recursive: true, force: true })),
          );
          const worker = yield* Effect.acquireRelease(
            Effect.sync(() => runtime(directory, { controlled: false })),
            (worker) => Effect.promise(() => worker.dispose()),
          );
          const url = (yield* Effect.promise(() => worker.ready)).toString();
          const admin = yield* make({ url, token: Redacted.make("cirro-local-test-credential") });
          yield* admin.create({
            id: "cutover",
            policy: {
              networkHosts: [],
              interruptBudget: 100000,
              memoryBytes: 8388608,
              maxOutputBytes: 1048576,
            },
          });
          const grant = yield* admin.mintCapability("cutover", {
            permissions: ["read", "execute"],
            expiresInSeconds: 60,
          });
          const client = yield* make({ url, token: Redacted.make(grant.token) });
          const source = Buffer.from(
            yield* Effect.promise(() => Bun.file("dist/wasi-pty-sink.wasm").arrayBuffer()),
          ).toString("base64");
          for (const mode of ["pty", "pipe"] as const)
            yield* client.action("cutover", {
              op: "process.spawn",
              stdinMode: mode,
              execution: {
                op: "process.run",
                id: mode,
                language: "wasm",
                source,
                stdin: { content: "seed", encoding: "utf8" },
              },
            });
          const objects = yield* Effect.promise(() => worker.objects);
          yield* client.action("cutover", {
            op: "process.terminal.resize",
            id: "pty",
            cols: 120,
            rows: 40,
            revision: 0,
          });
          const before = [];
          for (const id of ["pty", "pipe"]) {
            const key = `process-input/cutover/${id}.json`;
            const object = yield* Effect.promise(() => objects.get(key));
            if (object === null) return yield* Effect.die("Missing native input head");
            const head = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(InputHead))(
              yield* Effect.promise(() => object.text()),
            );
            before.push({ id, head });
            if (id === "pty") {
              yield* Effect.promise(() =>
                objects.put(
                  key,
                  Schema.encodeSync(Schema.fromJsonString(GeometryInput))({
                    ...Struct.omit(head, ["attributes", "version"]),
                    version: 2,
                  }),
                ),
              );
              continue;
            }
            yield* Effect.promise(() =>
              objects.put(
                key,
                Schema.encodeSync(Schema.fromJsonString(PreviousInput))({
                  ...Struct.omit(head, ["terminal", "attributes", "version"]),
                  version: 1,
                }),
              ),
            );
          }
          const rejected = yield* client
            .action("cutover", { op: "process.stdin.status", id: "pty" })
            .pipe(Effect.result);
          expect(Result.isFailure(rejected)).toBe(true);
          yield* Effect.forEach(
            Array.from({ length: 54 }, (_, index) => `orphan-${String(index).padStart(2, "0")}`),
            (id) =>
              Effect.promise(() =>
                objects.put(
                  `process-input/cutover/${id}.json`,
                  Schema.encodeSync(Schema.fromJsonString(PreviousInput))({
                    version: 1,
                    size: 0,
                    closed: false,
                    chunks: [],
                  }),
                ),
              ),
            { concurrency: 8 },
          );
          const endpoint = new URL("/v1/migrations/input-terminal-v3", url);
          const forbidden = yield* Effect.tryPromise(() =>
            fetch(endpoint, {
              method: "POST",
              keepalive: false,
              headers: { authorization: `Bearer ${grant.token}` },
              body: Schema.encodeSync(Schema.fromJsonString(InputMigrationInput))({ cursor: null }),
            }),
          );
          expect(forbidden.status).toBe(401);
          yield* Effect.promise(() => forbidden.text());
          const migrate = Effect.fn("test.input.migrate")((cursor: string | null) =>
            Effect.gen(function* () {
              const response = yield* Effect.tryPromise(() =>
                fetch(endpoint, {
                  method: "POST",
                  keepalive: false,
                  headers: {
                    authorization: "Bearer cirro-local-test-credential",
                    "content-type": "application/json",
                  },
                  body: Schema.encodeSync(Schema.fromJsonString(InputMigrationInput))({ cursor }),
                }),
              );
              expect(response.status).toBe(200);
              return yield* Schema.decodeUnknownEffect(InputMigrationReceipt)(
                yield* Effect.tryPromise(() => response.json()),
              );
            }),
          );
          const first = yield* migrate(null);
          expect(first.migrated).toBe(50);
          expect(first.cursor).not.toBeNull();
          const lost = yield* migrate(null);
          expect(lost.migrated).toBe(0);
          if (lost.cursor === null) return yield* Effect.die("Migration lost continuation");
          const last = yield* migrate(lost.cursor);
          expect(last).toEqual({ migrated: 6, cursor: null });
          for (const original of before) {
            const object = yield* Effect.promise(() =>
              objects.get(`process-input/cutover/${original.id}.json`),
            );
            if (object === null) return yield* Effect.die("Migrated input head missing");
            const head = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(InputHead))(
              yield* Effect.promise(() => object.text()),
            );
            expect(Struct.omit(head, ["terminal"])).toEqual(
              Struct.omit(original.head, ["terminal"]),
            );
            expect(head.terminal).toEqual(original.head.terminal);
          }
          expect(
            yield* client.action("cutover", { op: "process.stdin.status", id: "pty" }),
          ).toEqual({ offset: 4, total: 4, closed: false });
          yield* client.action("cutover", {
            op: "process.terminal.resize",
            id: "pty",
            cols: 132,
            rows: 45,
            revision: 1,
          });
          const configured = yield* client.action("cutover", {
            op: "process.terminal.configure",
            id: "pty",
            revision: 0,
            attributes: {
              icrnl: false,
              opost: false,
              onlcr: false,
              icanon: false,
              echo: false,
              isig: false,
              cc: [1, 2, 3, 4, 5, 6, 7],
            },
          });
          expect(configured.revision).toBe(1);
          expect(
            yield* client
              .action("cutover", { op: "process.terminal.attributes", id: "pty", timeoutMs: 0 })
              .pipe(Effect.flip),
          ).toMatchObject({ status: 408 });
          const configuredHead = yield* Effect.promise(() =>
            objects.head("process-input/cutover/pty.json"),
          );
          const repeated = yield* migrate(null);
          expect(repeated.migrated).toBe(0);
          if (repeated.cursor !== null) expect((yield* migrate(repeated.cursor)).migrated).toBe(0);
          expect(
            (yield* Effect.promise(() => objects.head("process-input/cutover/pty.json")))?.etag,
          ).toBe(configuredHead?.etag);
          expect(
            yield* client.action("cutover", { op: "process.terminal.status", id: "pty" }),
          ).toEqual({ cols: 132, rows: 45, revision: 2 });
          expect(
            yield* client
              .action("cutover", { op: "process.terminal.status", id: "pipe" })
              .pipe(Effect.flip),
          ).toMatchObject({ status: 400 });
          const brokenKey = "process-input/cutover/broken.json";
          yield* Effect.promise(() =>
            objects.put(
              brokenKey,
              Schema.encodeSync(Schema.fromJsonString(PreviousInput))({
                version: 1,
                size: 1,
                closed: false,
                chunks: [],
              }),
            ),
          );
          const broken = yield* Effect.promise(() => objects.head(brokenKey));
          const failed = yield* Effect.tryPromise(() =>
            fetch(endpoint, {
              method: "POST",
              keepalive: false,
              headers: { authorization: "Bearer cirro-local-test-credential" },
              body: Schema.encodeSync(Schema.fromJsonString(InputMigrationInput))({ cursor: null }),
            }),
          );
          expect(failed.status).toBe(500);
          yield* Effect.promise(() => failed.text());
          expect((yield* Effect.promise(() => objects.head(brokenKey)))?.etag).toBe(broken?.etag);
          yield* Effect.promise(() =>
            objects.put(
              brokenKey,
              Schema.encodeSync(Schema.fromJsonString(PreviousInput))({
                version: 1,
                size: 0,
                closed: false,
                chunks: [],
              }),
            ),
          );
          const repaired = yield* migrate(null);
          expect(repaired.migrated).toBe(1);
          if (repaired.cursor !== null) expect((yield* migrate(repaired.cursor)).migrated).toBe(0);
        }),
      ).pipe(
        Effect.provide(FetchHttpClient.layer),
        Effect.provideService(FetchHttpClient.RequestInit, { keepalive: false }),
      ),
    ),
  15000,
);
