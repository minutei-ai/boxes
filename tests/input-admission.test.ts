import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { Effect, Redacted, Schema } from "effect";
import { FetchHttpClient } from "effect/http";
import { make } from "../src/sdk";
import { InputHead, InputReceipt } from "../src/contracts";
import { runtime } from "../tooling/worker-test";

test("stdin admission overlaps independent reads without redundant HEAD or weakening lifetime checks", () =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const directory = yield* Effect.acquireRelease(
          Effect.promise(() => mkdtemp("/tmp/boxes-input-admission-")),
          (path) => Effect.promise(() => rm(path, { recursive: true, force: true })),
        );
        const worker = yield* Effect.acquireRelease(
          Effect.sync(() => runtime(directory, { controlled: false })),
          (worker) => Effect.promise(() => worker.dispose()),
        );
        const url = (yield* Effect.promise(() => worker.ready)).toString();
        const admin = yield* make({ url, token: Redacted.make("cirro-local-test-credential") });
        yield* admin.create({
          id: "admission",
          policy: {
            networkHosts: [],
            interruptBudget: 100000,
            memoryBytes: 8388608,
            maxOutputBytes: 1048576,
          },
        });
        const grant = yield* admin.mintCapability("admission", {
          permissions: ["read", "execute", "manage"],
          expiresInSeconds: 60,
        });
        const client = yield* make({ url, token: Redacted.make(grant.token) });
        yield* client.action("admission", {
          op: "process.spawn",
          stdinMode: "pty",
          execution: {
            op: "process.run",
            id: "input",
            language: "wasm",
            source: Buffer.from(
              yield* Effect.promise(() => Bun.file("dist/wasi-pty-sink.wasm").arrayBuffer()),
            ).toString("base64"),
          },
        });
        const control = yield* Effect.promise(() => worker.control);
        const action = {
          op: "process.stdin.write",
          id: "input",
          offset: 0,
          content: "one",
          encoding: "utf8",
        } as const;
        const written = yield* Effect.promise(() =>
          control.inputRequests("admission", grant.token, action),
        );
        expect(written.status).toBe(200);
        expect(Schema.decodeUnknownSync(Schema.fromJsonString(InputReceipt))(written.body)).toEqual(
          {
            offset: 3,
            total: 3,
            closed: false,
          },
        );
        expect({
          gets: written.requests.filter((request) => request.startsWith("get:")).length,
          heads: written.requests.filter((request) => request.startsWith("head:")).length,
          puts: written.requests.filter((request) => request.startsWith("put:")).length,
        }).toEqual({ gets: 4, heads: 0, puts: 2 });
        expect(written.requests.slice(0, 3).toSorted()).toEqual([
          "get:process-input/admission/input.json",
          "get:processes/admission/input.json",
          "get:sandboxes/admission/head.json",
        ]);
        expect(
          written.requests.filter((request) => request === "get:sandboxes/admission/head.json"),
        ).toHaveLength(2);
        const objects = yield* Effect.promise(() => worker.objects);
        const head = yield* Effect.promise(() => objects.get("process-input/admission/input.json"));
        if (head === null) return yield* Effect.die("Missing admitted input");
        const saved = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(InputHead))(
          yield* Effect.promise(() => head.text()),
        );
        expect(saved.size).toBe(3);
        expect(saved.chunks).toHaveLength(1);
        const chunk = saved.chunks[0];
        if (chunk === undefined) return yield* Effect.die("Missing admitted input block");
        const blob = yield* Effect.promise(() =>
          objects.get(`sandboxes/admission/stdin/${chunk.hash}`),
        );
        if (blob === null) return yield* Effect.die("Missing retained stdin bytes");
        expect(yield* Effect.promise(() => blob.text())).toBe("one");
        const replayed = yield* Effect.promise(() =>
          control.inputRequests("admission", grant.token, action),
        );
        expect(replayed.status).toBe(200);
        expect(replayed.requests.filter((request) => request.startsWith("put:"))).toEqual([]);
        const readonly = yield* admin.mintCapability("admission", {
          permissions: ["read"],
          expiresInSeconds: 60,
        });
        const denied = yield* Effect.promise(() =>
          control.inputRequests("admission", readonly.token, { ...action, offset: 3 }),
        );
        expect(denied.status).toBe(403);
        expect(denied.requests).toEqual([]);
        yield* client.action("admission", { op: "vm.dispose" });
        const disposed = yield* Effect.promise(() =>
          control.inputRequests("admission", grant.token, { ...action, offset: 3 }),
        );
        expect(disposed.status).toBe(404);
        expect(disposed.requests.filter((request) => request.startsWith("put:"))).toEqual([]);
      }),
    ).pipe(
      Effect.provide(FetchHttpClient.layer),
      Effect.provideService(FetchHttpClient.RequestInit, { keepalive: false }),
    ),
  ));
