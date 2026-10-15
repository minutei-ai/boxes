import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Redacted } from "effect";
import { FetchHttpClient } from "effect/http";
import { make } from "../src/sdk";
import { runtime } from "../tooling/worker-test";

test(
  "append preserves binary boundaries and aliases with write-only authority, bounded block reads and fenced publication",
  () =>
    Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const directory = yield* Effect.acquireRelease(
            Effect.promise(() => mkdtemp(join(tmpdir(), "boxes-append-"))),
            (path) => Effect.promise(() => rm(path, { recursive: true, force: true })),
          );
          const worker = yield* Effect.acquireRelease(
            Effect.sync(() => runtime(directory)),
            (worker) => Effect.promise(() => worker.dispose()),
          );
          const url = (yield* Effect.promise(() => worker.ready)).toString();
          const admin = yield* make({ url, token: Redacted.make("cirro-local-test-credential") });
          const id = "append";
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
          const initial = Buffer.from(Array.from({ length: 262142 }, (_, index) => index % 251));
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
          const before = yield* owner.action(id, {
            op: "filesystem.stat",
            path: "/tmp/data",
            follow: true,
          });
          yield* owner.action(id, { op: "filesystem.chmod", path: "/tmp/data", mode: 0o200 });
          yield* writer.action(id, {
            op: "filesystem.appendFile",
            path: "/tmp/link",
            content: "🙂\n",
          });
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
          ).toEqual(Buffer.concat([initial, Buffer.from("🙂\n")]));
          expect(
            yield* owner.action(id, { op: "filesystem.stat", path: "/tmp/alias", follow: true }),
          ).toMatchObject({ inode: before.inode, nlink: 2 });
          const status = yield* owner.action(id, { op: "vm.status" });
          yield* writer.action(id, { op: "filesystem.appendFile", path: "/tmp/data", content: "" });
          expect((yield* owner.action(id, { op: "vm.status" })).generation).toBe(status.generation);
          yield* writer.action(id, {
            op: "filesystem.appendFile",
            path: "/tmp/empty",
            content: "",
          });
          expect(
            (yield* owner.action(id, { op: "filesystem.stat", path: "/tmp/empty", follow: true }))
              .size,
          ).toBe(0);
          yield* owner.action(id, { op: "filesystem.chmod", path: "/tmp/data", mode: 0o400 });
          expect(
            yield* writer
              .action(id, { op: "filesystem.appendFile", path: "/tmp/data", content: "denied" })
              .pipe(Effect.flip),
          ).toMatchObject({ error: "EACCES", status: 403 });
          const aligned = Buffer.alloc(262144, 90);
          yield* owner.action(id, {
            op: "filesystem.writeFile",
            path: "/tmp/aligned",
            content: aligned.toString("base64"),
            encoding: "base64",
          });
          const digest = Buffer.from(
            yield* Effect.promise(() => crypto.subtle.digest("SHA-256", aligned)),
          ).toString("hex");
          const bucket = yield* Effect.promise(() => worker.objects);
          const key = `sandboxes/${id}/blobs/${digest}`;
          yield* Effect.promise(() => bucket.delete(key));
          expect(yield* Effect.promise(() => bucket.get(key))).toBeNull();
          yield* writer.action(id, {
            op: "filesystem.appendFile",
            path: "/tmp/aligned",
            content: "tail",
          });
          expect(
            (yield* owner.action(id, {
              op: "filesystem.readFile",
              path: "/tmp/aligned",
              offset: 262144,
              length: 4,
            })).content,
          ).toBe(Buffer.from("tail").toString("base64"));
          expect(
            yield* owner
              .action(id, { op: "filesystem.readFile", path: "/tmp/aligned", offset: 0, length: 1 })
              .pipe(Effect.flip),
          ).toMatchObject({ error: "EIO" });
          yield* Effect.promise(() => bucket.put(key, aligned));
          expect(
            Buffer.from(
              (yield* owner.action(id, { op: "filesystem.readFile", path: "/tmp/aligned" }))
                .content,
              "base64",
            ),
          ).toEqual(Buffer.concat([aligned, Buffer.from("tail")]));
          yield* owner.action(id, {
            op: "filesystem.writeFile",
            path: "/tmp/full",
            content: "x".repeat(16777216),
            encoding: "utf8",
          });
          const blobs = yield* Effect.promise(() =>
            bucket.list({ prefix: `sandboxes/${id}/blobs/` }),
          );
          const head = yield* Effect.promise(() => bucket.get(`sandboxes/${id}/head.json`));
          expect(
            yield* writer
              .action(id, { op: "filesystem.appendFile", path: "/tmp/full", content: "x" })
              .pipe(Effect.flip),
          ).toMatchObject({ error: "EFBIG", status: 413 });
          expect((yield* Effect.promise(() => bucket.get(`sandboxes/${id}/head.json`)))?.etag).toBe(
            head?.etag,
          );
          expect(
            (yield* Effect.promise(() => bucket.list({ prefix: `sandboxes/${id}/blobs/` })))
              .objects,
          ).toHaveLength(blobs.objects.length);
          yield* owner.action(id, {
            op: "filesystem.writeFile",
            path: "/tmp/race",
            content: "seed",
            encoding: "utf8",
          });
          const results = yield* Effect.forEach(
            ["A", "B"],
            (suffix) =>
              writer
                .action(id, { op: "filesystem.appendFile", path: "/tmp/race", content: suffix })
                .pipe(
                  Effect.result,
                  Effect.map((result) => ({ suffix, result })),
                ),
            { concurrency: 2 },
          );
          for (const result of results)
            if (result.result._tag === "Failure")
              expect(result.result.failure).toMatchObject({ error: "CONFLICT", status: 409 });
          const confirmed = results
            .filter((result) => result.result._tag === "Success")
            .map((result) => result.suffix);
          expect(confirmed.length).toBeGreaterThan(0);
          const final = Buffer.from(
            (yield* owner.action(id, { op: "filesystem.readFile", path: "/tmp/race" })).content,
            "base64",
          ).toString();
          expect(final.slice(0, 4)).toBe("seed");
          expect([...final.slice(4)].toSorted()).toEqual(confirmed.toSorted());
        }),
      ).pipe(Effect.provide(FetchHttpClient.layer)),
    ),
  15000,
);
