import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Redacted, Schema } from "effect";
import { FetchHttpClient } from "effect/http";
import { make } from "../src/sdk";
import { Action, ErrorResponse, Head } from "../src/contracts";
import { runtime } from "../tooling/worker-test";

test("disposal is durable and idempotent without weakening authority or reusing its ID", () =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const directory = yield* Effect.acquireRelease(
          Effect.promise(() => mkdtemp(join(tmpdir(), "boxes-dispose-"))),
          (path) => Effect.promise(() => rm(path, { recursive: true, force: true })),
        );
        const id = "dispose";
        const retained = yield* Effect.scoped(
          Effect.gen(function* () {
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
            yield* admin.create({ id, policy });
            const grant = yield* admin.mintCapability(id, {
              permissions: ["read", "write", "execute", "manage"],
              expiresInSeconds: 600,
            });
            const readonly = yield* admin.mintCapability(id, {
              permissions: ["read"],
              expiresInSeconds: 600,
            });
            const expiring = yield* admin.mintCapability(id, {
              permissions: ["manage"],
              expiresInSeconds: 1,
            });
            const client = yield* make({ url, token: Redacted.make(grant.token) });
            yield* client.action(id, {
              op: "filesystem.writeFile",
              path: "/tmp/retained",
              content: "confirmed",
              encoding: "utf8",
            });
            expect(yield* client.action(id, { op: "vm.dispose" })).toEqual({ ok: true });
            const objects = yield* Effect.promise(() => worker.objects);
            const object = yield* Effect.promise(() => objects.get(`sandboxes/${id}/head.json`));
            if (object === null) return yield* Effect.die("Disposal fence missing");
            const head = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Head))(
              yield* Effect.promise(() => object.text()),
            );
            expect(head.deleted).toBe(true);
            expect(object.version.length).toBeGreaterThan(0);
            expect(yield* client.action(id, { op: "vm.dispose" })).toEqual({ ok: true });
            const repeated = yield* Effect.promise(() => objects.head(`sandboxes/${id}/head.json`));
            expect(repeated?.version).toBe(object.version);
            return {
              grant,
              readonly,
              expiring,
              policy,
              etag: object.etag,
              version: object.version,
            };
          }),
        );
        const replacement = yield* Effect.acquireRelease(
          Effect.sync(() => runtime(directory)),
          (worker) => Effect.promise(() => worker.dispose()),
        );
        const url = (yield* Effect.promise(() => replacement.ready)).toString();
        const client = yield* make({ url, token: Redacted.make(retained.grant.token) });
        expect(yield* client.action(id, { op: "vm.dispose" })).toEqual({ ok: true });
        const objects = yield* Effect.promise(() => replacement.objects);
        const object = yield* Effect.promise(() => objects.head(`sandboxes/${id}/head.json`));
        expect(object?.etag).toBe(retained.etag);
        expect(object?.version).toBe(retained.version);
        expect(yield* client.action(id, { op: "vm.status" }).pipe(Effect.flip)).toMatchObject({
          _tag: "BoxesError",
          status: 404,
          error: "ENOENT",
        });
        const reader = yield* make({ url, token: Redacted.make(retained.readonly.token) });
        expect(yield* reader.action(id, { op: "vm.dispose" }).pipe(Effect.flip)).toMatchObject({
          _tag: "BoxesError",
          status: 403,
          error: "FORBIDDEN",
        });
        const expired = yield* Effect.promise(() =>
          fetch(new URL(`/v1/sandboxes/${id}/action`, url), {
            method: "POST",
            headers: {
              authorization: `Bearer ${retained.expiring.token}`,
              "content-type": "application/json",
              "x-boxes-test-clock-start": String(retained.expiring.expiresAt + 1),
            },
            body: Schema.encodeSync(Schema.fromJsonString(Action))({ op: "vm.dispose" }),
          }),
        );
        expect(expired.status).toBe(401);
        const denied = yield* Schema.decodeUnknownEffect(ErrorResponse)(
          yield* Effect.promise(() => expired.json()),
        );
        expect(denied.error).toBe("UNAUTHORIZED");
        expect(yield* client.action("other", { op: "vm.dispose" }).pipe(Effect.flip)).toMatchObject(
          {
            _tag: "BoxesError",
            status: 401,
            error: "UNAUTHORIZED",
          },
        );
        const admin = yield* make({ url, token: Redacted.make("cirro-local-test-credential") });
        expect(
          yield* admin.create({ id, policy: retained.policy }).pipe(Effect.flip),
        ).toMatchObject({
          _tag: "BoxesError",
          status: 409,
          error: "EEXIST",
        });
        yield* admin.create({ id: "concurrent", policy: retained.policy });
        const grant = yield* admin.mintCapability("concurrent", {
          permissions: ["manage"],
          expiresInSeconds: 600,
        });
        const concurrent = yield* make({ url, token: Redacted.make(grant.token) });
        const results = yield* Effect.forEach(
          [0, 1, 2],
          () => concurrent.action("concurrent", { op: "vm.dispose" }),
          { concurrency: 3 },
        );
        expect(results).toEqual([{ ok: true }, { ok: true }, { ok: true }]);
      }),
    ).pipe(Effect.provide(FetchHttpClient.layer)),
  ));
