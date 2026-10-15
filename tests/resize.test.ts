import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Redacted } from "effect";
import { FetchHttpClient } from "effect/http";
import { make } from "../src/sdk";
import { runtime } from "../tooling/worker-test";

test(
  "truncate retains bytes and inode authority while fetching only changed boundaries and fencing publication",
  () =>
    Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const directory = yield* Effect.acquireRelease(
            Effect.promise(() => mkdtemp(join(tmpdir(), "boxes-resize-"))),
            (path) => Effect.promise(() => rm(path, { recursive: true, force: true })),
          );
          const worker = yield* Effect.acquireRelease(
            Effect.sync(() => runtime(directory)),
            (worker) => Effect.promise(() => worker.dispose()),
          );
          const url = (yield* Effect.promise(() => worker.ready)).toString();
          const admin = yield* make({ url, token: Redacted.make("cirro-local-test-credential") });
          const id = "resize";
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
            permissions: ["read", "write"],
            expiresInSeconds: 600,
          });
          const owner = yield* make({ url, token: Redacted.make(grant.token) });
          const writeGrant = yield* admin.mintCapability(id, {
            permissions: ["write"],
            expiresInSeconds: 600,
          });
          const writer = yield* make({ url, token: Redacted.make(writeGrant.token) });
          const initial = Buffer.from(Array.from({ length: 786463 }, (_, index) => index % 251));
          yield* owner.action(id, {
            op: "filesystem.writeFile",
            path: "/tmp/data",
            content: initial.toString("base64"),
            encoding: "base64",
          });
          yield* owner.action(id, {
            op: "filesystem.link",
            from: "/tmp/data",
            to: "/tmp/alias",
            follow: false,
          });
          yield* owner.action(id, { op: "filesystem.symlink", path: "/tmp/link", target: "alias" });
          yield* owner.action(id, {
            op: "filesystem.chown",
            path: "/tmp/data",
            uid: 123,
            gid: 456,
            follow: false,
          });
          const before = yield* owner.action(id, {
            op: "filesystem.stat",
            path: "/tmp/data",
            follow: true,
          });
          yield* owner.action(id, { op: "filesystem.chmod", path: "/tmp/data", mode: 0o200 });
          yield* writer.action(id, { op: "filesystem.truncate", path: "/tmp/link", size: 262153 });
          expect(
            yield* writer
              .action(id, { op: "filesystem.readFile", path: "/tmp/data" })
              .pipe(Effect.flip),
          ).toMatchObject({ error: "FORBIDDEN", status: 403 });
          yield* owner.action(id, { op: "filesystem.chmod", path: "/tmp/data", mode: 0o600 });
          expect(
            Buffer.from(
              (yield* owner.action(id, { op: "filesystem.readFile", path: "/tmp/alias" })).content,
              "base64",
            ),
          ).toEqual(initial.subarray(0, 262153));
          expect(
            yield* owner.action(id, { op: "filesystem.stat", path: "/tmp/alias", follow: true }),
          ).toMatchObject({ inode: before.inode, nlink: 2, uid: 123, gid: 456 });
          yield* writer.action(id, { op: "filesystem.truncate", path: "/tmp/data", size: 524293 });
          const grown = Buffer.alloc(524293);
          initial.copy(grown, 0, 0, 262153);
          expect(
            Buffer.from(
              (yield* owner.action(id, { op: "filesystem.readFile", path: "/tmp/data" })).content,
              "base64",
            ),
          ).toEqual(grown);
          const status = yield* owner.action(id, { op: "vm.status" });
          yield* writer.action(id, { op: "filesystem.truncate", path: "/tmp/data", size: 524293 });
          expect((yield* owner.action(id, { op: "vm.status" })).generation).toBe(
            status.generation + 1,
          );
          yield* writer.action(id, { op: "filesystem.truncate", path: "/tmp/data", size: 0 });
          expect(
            (yield* owner.action(id, { op: "filesystem.readFile", path: "/tmp/alias" })).content,
          ).toBe("");
          expect(
            yield* writer
              .action(id, { op: "filesystem.truncate", path: "/tmp/missing", size: 0 })
              .pipe(Effect.flip),
          ).toMatchObject({ error: "ENOENT", status: 404 });
          expect(
            (yield* owner.action(id, { op: "filesystem.exists", path: "/tmp/missing" })).exists,
          ).toBe(false);
          yield* owner.action(id, { op: "filesystem.chmod", path: "/tmp/data", mode: 0o400 });
          expect(
            yield* writer
              .action(id, { op: "filesystem.truncate", path: "/tmp/data", size: 0 })
              .pipe(Effect.flip),
          ).toMatchObject({ error: "EACCES", status: 403 });
          const first = Buffer.alloc(262144, 65);
          const discarded = Buffer.alloc(262144, 66);
          yield* owner.action(id, {
            op: "filesystem.writeFile",
            path: "/tmp/discard",
            content: Buffer.concat([first, discarded]).toString("base64"),
            encoding: "base64",
          });
          const digest = Buffer.from(
            yield* Effect.promise(() => crypto.subtle.digest("SHA-256", discarded)),
          ).toString("hex");
          const bucket = yield* Effect.promise(() => worker.objects);
          const key = `sandboxes/${id}/blobs/${digest}`;
          yield* Effect.promise(() => bucket.delete(key));
          yield* writer.action(id, {
            op: "filesystem.truncate",
            path: "/tmp/discard",
            size: 262144,
          });
          expect(
            Buffer.from(
              (yield* owner.action(id, { op: "filesystem.readFile", path: "/tmp/discard" }))
                .content,
              "base64",
            ),
          ).toEqual(first);
          yield* owner.action(id, {
            op: "filesystem.writeFile",
            path: "/tmp/boundary",
            content: discarded.toString("base64"),
            encoding: "base64",
          });
          yield* Effect.promise(() => bucket.delete(key));
          const head = yield* Effect.promise(() => bucket.get(`sandboxes/${id}/head.json`));
          const blobs = yield* Effect.promise(() =>
            bucket.list({ prefix: `sandboxes/${id}/blobs/` }),
          );
          expect(
            yield* writer
              .action(id, { op: "filesystem.truncate", path: "/tmp/boundary", size: 1 })
              .pipe(Effect.flip),
          ).toMatchObject({ error: "EIO" });
          expect((yield* Effect.promise(() => bucket.get(`sandboxes/${id}/head.json`)))?.etag).toBe(
            head?.etag,
          );
          expect(
            (yield* Effect.promise(() => bucket.list({ prefix: `sandboxes/${id}/blobs/` })))
              .objects,
          ).toHaveLength(blobs.objects.length);
          yield* Effect.promise(() => bucket.put(key, discarded));
          yield* owner.action(id, {
            op: "filesystem.writeFile",
            path: "/tmp/race",
            content: initial.toString("base64"),
            encoding: "base64",
          });
          const results = yield* Effect.forEach(
            [262144, 262145],
            (size) =>
              writer.action(id, { op: "filesystem.truncate", path: "/tmp/race", size }).pipe(
                Effect.result,
                Effect.map((result) => ({ size, result })),
              ),
            { concurrency: 2 },
          );
          for (const result of results)
            if (result.result._tag === "Failure")
              expect(result.result.failure).toMatchObject({ error: "CONFLICT", status: 409 });
          const confirmed = results
            .filter((result) => result.result._tag === "Success")
            .map((result) => result.size);
          expect(confirmed.length).toBeGreaterThan(0);
          const final = Buffer.from(
            (yield* owner.action(id, { op: "filesystem.readFile", path: "/tmp/race" })).content,
            "base64",
          );
          expect(confirmed).toContain(final.length);
          expect(final.subarray(0, 262144)).toEqual(initial.subarray(0, 262144));
        }),
      ).pipe(Effect.provide(FetchHttpClient.layer)),
    ),
  15000,
);
