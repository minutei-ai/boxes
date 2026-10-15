import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Redacted, Schema } from "effect";
import { FetchHttpClient } from "effect/http";
import { make } from "../src/sdk";
import { Action, ErrorResponse, Head, StoredRun, ProcessDelivery } from "../src/contracts";
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

test("disposal settles queued work even when its archived program awaits a newer runtime", () =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const directory = yield* Effect.acquireRelease(
          Effect.promise(() => mkdtemp(join(tmpdir(), "boxes-disposed-queue-"))),
          (path) => Effect.promise(() => rm(path, { recursive: true, force: true })),
        );
        const id = "disposed-archive";
        const retained = yield* Effect.scoped(
          Effect.gen(function* () {
            const worker = yield* Effect.acquireRelease(
              Effect.sync(() => runtime(directory)),
              (value) => Effect.promise(() => value.dispose()),
            );
            const url = (yield* Effect.promise(() => worker.ready)).toString();
            const admin = yield* make({ url, token: Redacted.make("cirro-local-test-credential") });
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
              permissions: ["read", "execute", "manage"],
              expiresInSeconds: 600,
            });
            const client = yield* make({ url, token: Redacted.make(grant.token) });
            const accepted = yield* client.action(id, {
              op: "process.spawn",
              execution: {
                op: "process.run",
                id: "waiting",
                language: "javascript",
                source: "export default () => 42;",
              },
            });
            const objects = yield* Effect.promise(() => worker.objects);
            const codeKey = `sandboxes/${id}/code/${accepted.sourceHash}`;
            const code = yield* Effect.promise(() => objects.get(codeKey));
            if (code === null) return yield* Effect.die("Missing archived program");
            const bytes = yield* Effect.promise(() => code.arrayBuffer());
            const updated = yield* Effect.promise(() =>
              objects.put(codeKey, bytes, {
                onlyIf: { etagMatches: code.etag },
                customMetadata: { format: "program-json-future" },
              }),
            );
            expect(updated).not.toBeNull();
            const key = `processes/${id}/waiting.json`;
            const receipt = yield* Effect.promise(() => objects.head(key));
            if (receipt === null) return yield* Effect.die("Missing queued receipt");
            const event = Schema.encodeSync(ProcessDelivery)({ key, eTag: receipt.etag });
            const control = yield* Effect.promise(() => worker.control);
            const held = yield* Effect.promise(() =>
              control.deliver("executions", [
                { id: "before-disposal", timestamp: new Date(), attempts: 1, body: event },
              ]),
            );
            expect(held.outcome).toBe("ok");
            expect(held.retryMessages).toEqual([{ msgId: "before-disposal", delaySeconds: 15 }]);
            expect(held.explicitAcks).toEqual([]);
            const before = yield* Effect.promise(() => objects.get(key));
            if (before === null) return yield* Effect.die("Missing pending receipt");
            const pending = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(StoredRun))(
              yield* Effect.promise(() => before.text()),
            );
            expect(pending.status).toBe("queued");
            expect(pending.authority).not.toBeNull();
            expect(before.etag).toBe(receipt.etag);
            yield* client.action(id, { op: "vm.dispose" });
            return { event, key };
          }),
        );
        const next = yield* Effect.acquireRelease(
          Effect.sync(() => runtime(directory)),
          (value) => Effect.promise(() => value.dispose()),
        );
        yield* Effect.promise(() => next.ready);
        const control = yield* Effect.promise(() => next.control);
        const delivered = yield* Effect.promise(() =>
          control.deliver("executions", [
            { id: "after-disposal", timestamp: new Date(), attempts: 2, body: retained.event },
          ]),
        );
        expect(delivered.outcome).toBe("ok");
        expect(delivered.explicitAcks).toEqual(["after-disposal"]);
        expect(delivered.retryMessages).toEqual([]);
        const objects = yield* Effect.promise(() => next.objects);
        const receipt = yield* Effect.promise(() => objects.get(retained.key));
        if (receipt === null) return yield* Effect.die("Missing settled receipt");
        const settled = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(StoredRun))(
          yield* Effect.promise(() => receipt.text()),
        );
        expect(settled.status).toBe("cancelled");
        expect(settled.authority).toBeNull();
        expect(settled.deadlineAt).toBeNull();
        expect(settled.checkpoint).toBeNull();
        expect(settled.output).toBeNull();
        expect(settled.finishedAt).not.toBeNull();
        yield* Effect.promise(() =>
          control.deliver("executions", [
            { id: "duplicate", timestamp: new Date(), attempts: 3, body: retained.event },
          ]),
        );
        expect((yield* Effect.promise(() => objects.head(retained.key)))?.version).toBe(
          receipt.version,
        );
      }),
    ).pipe(Effect.provide(FetchHttpClient.layer)),
  ));
