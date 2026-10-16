import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Redacted, Schema } from "effect";
import { FetchHttpClient } from "effect/http";
import { ProcessPage } from "../src/contracts";
import { make, makeBinding } from "../src/sdk";
import { runtime } from "../tooling/worker-test";

test("binding discovers terminal jobs through paginated R2 metadata without receipt or input reads", () =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const directory = yield* Effect.acquireRelease(
          Effect.promise(() => mkdtemp(join(tmpdir(), "boxes-process-inventory-"))),
          (path) => Effect.promise(() => rm(path, { recursive: true, force: true })),
        );
        const worker = yield* Effect.acquireRelease(
          Effect.sync(() => runtime(directory, { controlled: false })),
          (worker) => Effect.promise(() => worker.dispose()),
        );
        const url = (yield* Effect.promise(() => worker.ready)).toString();
        const admin = yield* make({ url, token: Redacted.make("cirro-local-test-credential") });
        yield* admin.create({
          id: "inventory",
          policy: {
            networkHosts: [],
            interruptBudget: 1000,
            memoryBytes: 8388608,
            maxOutputBytes: 1048576,
          },
        });
        const grant = yield* admin.mintCapability("inventory", {
          permissions: ["read", "execute"],
          expiresInSeconds: 60,
        });
        const client = yield* makeBinding(
          yield* Effect.promise(() => worker.service),
          Redacted.make(grant.token),
        );
        const source = Buffer.from(
          yield* Effect.promise(() => Bun.file("dist/wasi-pty-sink.wasm").arrayBuffer()),
        ).toString("base64");
        const jobs = (
          [
            ["closed", 8],
            ["pipe", 8],
            ["pty", 15],
          ] as const
        ).flatMap(([stdinMode, count], section) =>
          Array.from({ length: count }, (_, index) => ({
            id: `${section}-${String(index).padStart(2, "0")}`,
            stdinMode,
          })),
        );
        yield* Effect.forEach(
          jobs,
          (job) =>
            client.action("inventory", {
              op: "process.spawn",
              stdinMode: job.stdinMode,
              execution: { op: "process.run", id: job.id, language: "wasm", source },
            }),
          { concurrency: 4 },
        );
        const all = yield* client.action("inventory", {
          op: "process.list",
          limit: 50,
          cursor: null,
        });
        expect(all.items.map((item) => ({ id: item.id, stdinMode: item.stdinMode }))).toEqual(jobs);
        expect(all.cursor).toBeNull();
        const readonly = yield* admin.mintCapability("inventory", {
          permissions: ["read"],
          expiresInSeconds: 60,
        });
        const control = yield* Effect.promise(() => worker.control);
        const pages: (typeof ProcessPage.Type)[] = [];
        const cursors: (typeof ProcessPage.Type.cursor)[] = [null];
        while (cursors.length > 0) {
          const cursor = cursors.shift();
          if (cursor === undefined) return yield* Effect.die("Missing listing cursor");
          const response = yield* Effect.promise(() =>
            control.listProcesses("inventory", readonly.token, {
              op: "process.list",
              stdinMode: "pty",
              limit: 7,
              cursor,
            }),
          );
          expect(response).toMatchObject({
            status: 200,
            receiptReads: 0,
            inputReads: 0,
            listings: 1,
          });
          const page = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(ProcessPage))(
            response.body,
          );
          expect(page.items.length).toBeLessThanOrEqual(7);
          pages.push(page);
          if (page.cursor !== null) cursors.push(page.cursor);
        }
        expect(pages[0].items).toHaveLength(0);
        expect(pages[0].cursor).not.toBeNull();
        expect(pages.flatMap((page) => page.items).map((item) => item.id)).toEqual(
          jobs.filter((job) => job.stdinMode === "pty").map((job) => job.id),
        );
        const pipe = yield* client.action("inventory", {
          op: "process.list",
          stdinMode: "pipe",
          limit: 50,
          cursor: null,
        });
        expect(pipe.items.map((item) => item.id)).toEqual(
          jobs.filter((job) => job.stdinMode === "pipe").map((job) => job.id),
        );
        const closed = yield* client.action("inventory", {
          op: "process.list",
          stdinMode: "closed",
          limit: 50,
          cursor: null,
        });
        expect(closed.items.map((item) => item.id)).toEqual(
          jobs.filter((job) => job.stdinMode === "closed").map((job) => job.id),
        );
        const executor = yield* admin.mintCapability("inventory", {
          permissions: ["execute"],
          expiresInSeconds: 60,
        });
        const denied = yield* Effect.promise(() =>
          control.listProcesses("inventory", executor.token, {
            op: "process.list",
            stdinMode: "pty",
            limit: 50,
            cursor: null,
          }),
        );
        expect(denied).toMatchObject({ status: 403, receiptReads: 0, inputReads: 0, listings: 0 });
        expect(
          yield* client
            .action("neighbor", { op: "process.list", stdinMode: "pty", limit: 50, cursor: null })
            .pipe(Effect.flip),
        ).toMatchObject({ status: 401 });
        const malformed = yield* Effect.tryPromise(() =>
          fetch(new URL("/v1/sandboxes/inventory/action", url), {
            method: "POST",
            keepalive: false,
            headers: { authorization: `Bearer ${grant.token}`, "content-type": "application/json" },
            body: '{"op":"process.list","stdinMode":"raw","limit":50,"cursor":null}',
          }),
        );
        expect(malformed.status).toBe(400);
        yield* Effect.promise(() => malformed.text());
        const agent = yield* client.action("inventory", {
          op: "process.run",
          id: "z-agent",
          language: "typescript",
          source:
            'export default async ({tools}) => (await tools.call({op:"process.list",stdinMode:"pty",limit:50,cursor:null})).items.map(item => ({id:item.id,stdinMode:item.stdinMode}));',
        });
        expect(agent.status).toBe("exited");
        expect(agent.output?.result).toEqual(jobs.filter((job) => job.stdinMode === "pty"));
      }),
    ).pipe(
      Effect.provide(FetchHttpClient.layer),
      Effect.provideService(FetchHttpClient.RequestInit, { keepalive: false }),
    ),
  ));
