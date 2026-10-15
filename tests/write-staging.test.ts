import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { Effect, Redacted } from "effect";
import { FetchHttpClient } from "effect/http";
import { make } from "../src/sdk";
import { runtime } from "../tooling/worker-test";

test(
  "staged batches preserve inode alias ordering and the exact aggregate byte boundary",
  () =>
    Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const directory = yield* Effect.acquireRelease(
            Effect.promise(() => mkdtemp("/tmp/boxes-write-staging-")),
            (path) => Effect.promise(() => rm(path, { recursive: true, force: true })),
          );
          const worker = yield* Effect.acquireRelease(
            Effect.sync(() => runtime(directory)),
            (worker) => Effect.promise(() => worker.dispose()),
          );
          const url = (yield* Effect.promise(() => worker.ready)).toString();
          const admin = yield* make({ url, token: Redacted.make("cirro-local-test-credential") });
          const policy = {
            networkHosts: [],
            interruptBudget: 1000,
            memoryBytes: 8388608,
            maxOutputBytes: 1048576,
          };
          yield* admin.create({ id: "ordered", policy });
          const grant = yield* admin.mintCapability("ordered", {
            permissions: ["read", "write"],
            expiresInSeconds: 600,
          });
          const client = yield* make({ url, token: Redacted.make(grant.token) });
          yield* client.action("ordered", {
            op: "filesystem.writeFile",
            path: "/original",
            content: "old",
            encoding: "utf8",
          });
          yield* client.action("ordered", {
            op: "filesystem.link",
            from: "/original",
            to: "/alias",
            follow: true,
          });
          const before = yield* client.action("ordered", { op: "vm.status" });
          const results = yield* client.action("ordered", {
            op: "filesystem.writeFiles",
            entries: [
              { path: "/original", content: "first", encoding: "utf8" },
              { path: "/alias", content: "last", encoding: "utf8" },
              { path: "/alias/child", content: "forbidden", encoding: "utf8" },
              { path: "/same-a", content: "shared", encoding: "utf8" },
              { path: "/same-b", content: "shared", encoding: "utf8" },
            ],
          });
          expect(results.map((entry) => entry.success)).toEqual([true, true, false, true, true]);
          const read = yield* client.action("ordered", {
            op: "filesystem.readFiles",
            paths: ["/original", "/alias", "/same-a", "/same-b"],
          });
          expect(read.map((entry) => entry.content)).toEqual([
            "bGFzdA==",
            "bGFzdA==",
            "c2hhcmVk",
            "c2hhcmVk",
          ]);
          expect((yield* client.action("ordered", { op: "vm.status" })).generation).toBe(
            before.generation + 1,
          );
          const original = yield* client.action("ordered", {
            op: "filesystem.stat",
            path: "/original",
            follow: true,
          });
          const alias = yield* client.action("ordered", {
            op: "filesystem.stat",
            path: "/alias",
            follow: true,
          });
          expect(original.inode).toBe(alias.inode);

          yield* admin.create({ id: "boundary", policy });
          const authority = yield* admin.mintCapability("boundary", {
            permissions: ["read", "write"],
            expiresInSeconds: 600,
          });
          const bounded = yield* make({ url, token: Redacted.make(authority.token) });
          const entries = Array.from({ length: 128 }, (_, index) => ({
            path: `/file-${index}`,
            content: Buffer.alloc(131072, index).toString("base64"),
            encoding: "base64" as const,
          }));
          const written = yield* bounded.action("boundary", {
            op: "filesystem.writeFiles",
            entries,
          });
          expect(written).toHaveLength(128);
          expect(written.every((entry) => entry.success)).toBe(true);
          const status = yield* bounded.action("boundary", { op: "vm.status" });
          expect(status.filesystemBytes).toBe(16777216);
          const sampled = yield* bounded.action("boundary", {
            op: "filesystem.readFiles",
            paths: ["/file-0", "/file-63", "/file-127"],
          });
          expect(sampled.map((entry) => entry.content)).toEqual([
            entries[0].content,
            entries[63].content,
            entries[127].content,
          ]);
          const rejected = yield* bounded
            .action("boundary", {
              op: "filesystem.writeFiles",
              entries: [
                {
                  path: "/excess-a",
                  content: Buffer.alloc(8388608).toString("base64"),
                  encoding: "base64",
                },
                {
                  path: "/excess-b",
                  content: Buffer.alloc(8388609).toString("base64"),
                  encoding: "base64",
                },
              ],
            })
            .pipe(Effect.flip);
          expect(rejected).toMatchObject({ _tag: "BoxesError", status: 413, error: "EFBIG" });
          expect((yield* bounded.action("boundary", { op: "vm.status" })).generation).toBe(
            status.generation,
          );
          expect(
            (yield* bounded.action("boundary", { op: "filesystem.exists", path: "/excess-a" }))
              .exists,
          ).toBe(false);
        }),
      ).pipe(Effect.provide(FetchHttpClient.layer)),
    ),
  30000,
);
