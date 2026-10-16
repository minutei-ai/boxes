import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Redacted, Result, Schedule, Schema } from "effect";
import { FetchHttpClient } from "effect/http";
import { InputHead, TerminalAttributes } from "../src/contracts";
import { make, makeBinding } from "../src/sdk";
import { runtime } from "../tooling/worker-test";

const raw = Schema.decodeUnknownSync(TerminalAttributes)({
  icrnl: false,
  opost: false,
  onlcr: false,
  icanon: false,
  echo: false,
  isig: false,
  cc: [1, 2, 3, 4, 5, 6, 7],
});

test("binding observes native guest changes, explicit revisions and terminal settlement after EOF", () =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const directory = yield* Effect.acquireRelease(
          Effect.promise(() => mkdtemp(join(tmpdir(), "boxes-attributes-live-"))),
          (path) => Effect.promise(() => rm(path, { recursive: true, force: true })),
        );
        const worker = yield* Effect.acquireRelease(
          Effect.sync(() => runtime(directory, { consume: true, controlled: false })),
          (worker) => Effect.promise(() => worker.dispose()),
        );
        const admin = yield* make({
          url: (yield* Effect.promise(() => worker.ready)).toString(),
          token: Redacted.make("cirro-local-test-credential"),
        });
        yield* admin.create({
          id: "attributes",
          policy: {
            networkHosts: [],
            interruptBudget: 100000,
            memoryBytes: 8388608,
            maxOutputBytes: 1048576,
          },
        });
        const grant = yield* admin.mintCapability("attributes", {
          permissions: ["read", "execute"],
          expiresInSeconds: 60,
        });
        const client = yield* makeBinding(
          yield* Effect.promise(() => worker.service),
          Redacted.make(grant.token),
        );
        yield* client.action("attributes", {
          op: "process.spawn",
          stdinMode: "pty",
          execution: {
            op: "process.run",
            id: "live",
            language: "wasm",
            source: Buffer.from(
              yield* Effect.promise(() => Bun.file("dist/wasi-termios-api.wasm").arrayBuffer()),
            ).toString("base64"),
          },
        });
        const output = client.action("attributes", {
          op: "process.output.readLive",
          id: "live",
          after: null,
          maxBytes: 4096,
          maxEvents: 32,
        });
        const marker = Effect.fn("test.attributes.marker")((text: string) =>
          Effect.repeat(output, {
            until: (page) =>
              Effect.succeed(
                Buffer.concat(page.events.map((event) => Buffer.from(event.data, "base64")))
                  .toString()
                  .includes(text),
              ),
            schedule: Schedule.spaced("10 millis"),
          }).pipe(Effect.timeout("3 seconds")),
        );
        const observe = client.action("attributes", {
          op: "process.terminal.attributes",
          id: "live",
          timeoutMs: 2000,
        });
        yield* marker("attributes-ready\r\n");
        const initial = yield* observe;
        expect(initial.desired).toEqual({ attributes: null, revision: 0 });
        expect(initial.observed.revision).toBe(0);
        expect(initial.observed.attributes).toMatchObject({ icanon: true, echo: true, isig: true });
        expect(initial.settled).toBe(false);
        expect(
          yield* client.action("attributes", {
            op: "process.terminal.configure",
            id: "live",
            revision: 0,
            attributes: raw,
          }),
        ).toEqual({ attributes: raw, revision: 1 });
        expect((yield* observe).observed).toEqual({ attributes: raw, revision: 1 });
        yield* client.action("attributes", {
          op: "process.stdin.write",
          id: "live",
          offset: 0,
          content: "X",
          encoding: "utf8",
        });
        yield* marker("guest-changed\n");
        const guest = yield* observe;
        expect(guest.desired).toEqual({ attributes: raw, revision: 1 });
        expect(guest.observed).toEqual({ attributes: { ...raw, echo: true }, revision: 1 });
        yield* client.action("attributes", {
          op: "process.terminal.configure",
          id: "live",
          revision: 1,
          attributes: raw,
        });
        expect((yield* observe).observed).toEqual({ attributes: raw, revision: 2 });
        yield* client.action("attributes", {
          op: "process.stdin.write",
          id: "live",
          offset: 1,
          content: "Y",
          encoding: "utf8",
        });
        yield* client.action("attributes", { op: "process.stdin.close", id: "live", offset: 2 });
        yield* marker("eof-ready\n");
        const cooked = { ...raw, icrnl: true, opost: true, onlcr: true, icanon: true, isig: true };
        yield* client.action("attributes", {
          op: "process.terminal.configure",
          id: "live",
          revision: 2,
          attributes: cooked,
        });
        const record = yield* client.action("attributes", {
          op: "process.wait",
          id: "live",
          timeoutMs: 3000,
        });
        expect(record.status).toBe("exited");
        expect(record.output).toMatchObject({
          exitCode: 0,
          stderr: "",
          stdout:
            "attributes-ready\r\nraw-ok\nguest-changed\nconfigured-again\neof-ready\nterminal-done\r\n",
        });
        const objects = yield* Effect.promise(() => worker.objects);
        const before = yield* Effect.promise(() =>
          objects.head("process-input/attributes/live.json"),
        );
        const final = {
          desired: { attributes: cooked, revision: 3 },
          observed: { attributes: cooked, revision: 3 },
          settled: true,
        };
        expect(yield* observe).toEqual(final);
        expect(yield* observe).toEqual(final);
        expect(
          (yield* Effect.promise(() => objects.head("process-input/attributes/live.json")))?.etag,
        ).toBe(before?.etag);
        expect(
          yield* client
            .action("attributes", {
              op: "process.terminal.configure",
              id: "live",
              revision: 3,
              attributes: raw,
            })
            .pipe(Effect.flip),
        ).toMatchObject({ status: 409 });
      }),
    ).pipe(
      Effect.provide(FetchHttpClient.layer),
      Effect.provideService(FetchHttpClient.RequestInit, { keepalive: false }),
    ),
  ));

test("queued observations coalesce without fabricating native attributes and configuration uses CAS", () =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const directory = yield* Effect.acquireRelease(
          Effect.promise(() => mkdtemp(join(tmpdir(), "boxes-attributes-queued-"))),
          (path) => Effect.promise(() => rm(path, { recursive: true, force: true })),
        );
        const worker = yield* Effect.acquireRelease(
          Effect.sync(() => runtime(directory, { controlled: false })),
          (worker) => Effect.promise(() => worker.dispose()),
        );
        const url = (yield* Effect.promise(() => worker.ready)).toString();
        const admin = yield* make({ url, token: Redacted.make("cirro-local-test-credential") });
        yield* admin.create({
          id: "queued",
          policy: {
            networkHosts: [],
            interruptBudget: 100000,
            memoryBytes: 8388608,
            maxOutputBytes: 1048576,
          },
        });
        const grant = yield* admin.mintCapability("queued", {
          permissions: ["read", "execute"],
          expiresInSeconds: 60,
        });
        const service = yield* Effect.promise(() => worker.service);
        const client = yield* makeBinding(service, Redacted.make(grant.token));
        const source = Buffer.from(
          yield* Effect.promise(() => Bun.file("dist/wasi-termios-api.wasm").arrayBuffer()),
        ).toString("base64");
        for (const mode of ["pty", "pipe"] as const)
          yield* client.action("queued", {
            op: "process.spawn",
            stdinMode: mode,
            execution: { op: "process.run", id: mode, language: "wasm", source },
          });
        const results = yield* Effect.forEach(
          Array.from({ length: 8 }),
          () =>
            client
              .action("queued", { op: "process.terminal.attributes", id: "pty", timeoutMs: 0 })
              .pipe(Effect.flip),
          { concurrency: 8 },
        );
        for (const result of results) expect(result).toMatchObject({ status: 408 });
        const objects = yield* Effect.promise(() => worker.objects);
        const head = Effect.gen(function* () {
          const object = yield* Effect.promise(() => objects.get("process-input/queued/pty.json"));
          if (object === null) return yield* Effect.die("Missing native input head");
          return yield* Schema.decodeUnknownEffect(Schema.fromJsonString(InputHead))(
            yield* Effect.promise(() => object.text()),
          );
        });
        expect((yield* head).attributes).toMatchObject({
          requested: 1,
          observed: 0,
          snapshot: null,
        });
        const concurrent = yield* Effect.forEach(
          [0, 1],
          () =>
            client
              .action("queued", {
                op: "process.terminal.configure",
                id: "pty",
                revision: 0,
                attributes: raw,
              })
              .pipe(Effect.result),
          { concurrency: 2 },
        );
        expect(concurrent.filter(Result.isSuccess)).toHaveLength(1);
        expect(concurrent.filter(Result.isFailure)[0].failure).toMatchObject({ status: 409 });
        yield* client.action("queued", {
          op: "process.stdin.write",
          id: "pty",
          offset: 0,
          content: "seed",
          encoding: "utf8",
        });
        yield* client.action("queued", { op: "process.stdin.close", id: "pty", offset: 4 });
        yield* client.action("queued", {
          op: "process.terminal.resize",
          id: "pty",
          cols: 120,
          rows: 40,
          revision: 0,
        });
        yield* client.action("queued", {
          op: "process.terminal.configure",
          id: "pty",
          revision: 1,
          attributes: raw,
        });
        expect(yield* head).toMatchObject({
          size: 4,
          closed: true,
          terminal: { cols: 120, rows: 40, revision: 1 },
          attributes: {
            desired: { attributes: raw, revision: 2 },
            requested: 1,
            observed: 0,
            snapshot: null,
          },
        });
        const readonly = yield* admin.mintCapability("queued", {
          permissions: ["read"],
          expiresInSeconds: 60,
        });
        const reader = yield* makeBinding(service, Redacted.make(readonly.token));
        expect(
          yield* reader
            .action("queued", {
              op: "process.terminal.configure",
              id: "pty",
              revision: 2,
              attributes: raw,
            })
            .pipe(Effect.flip),
        ).toMatchObject({ status: 403 });
        expect(
          yield* reader
            .action("queued", { op: "process.terminal.attributes", id: "pty", timeoutMs: 0 })
            .pipe(Effect.flip),
        ).toMatchObject({ status: 408 });
        const executeonly = yield* admin.mintCapability("queued", {
          permissions: ["execute"],
          expiresInSeconds: 60,
        });
        const executor = yield* makeBinding(service, Redacted.make(executeonly.token));
        expect(
          yield* executor
            .action("queued", { op: "process.terminal.attributes", id: "pty", timeoutMs: 0 })
            .pipe(Effect.flip),
        ).toMatchObject({ status: 403 });
        expect(
          yield* client
            .action("neighbor", { op: "process.terminal.attributes", id: "pty", timeoutMs: 0 })
            .pipe(Effect.flip),
        ).toMatchObject({ status: 401 });
        expect(
          yield* client
            .action("queued", { op: "process.terminal.attributes", id: "pipe", timeoutMs: 0 })
            .pipe(Effect.flip),
        ).toMatchObject({ status: 400 });
        expect(
          yield* client
            .action("queued", {
              op: "process.terminal.configure",
              id: "pipe",
              revision: 0,
              attributes: raw,
            })
            .pipe(Effect.flip),
        ).toMatchObject({ status: 400 });
        const agent = yield* client.action("queued", {
          op: "process.run",
          id: "agent-configure",
          language: "typescript",
          source:
            'export default async ({ tools }) => tools.call({ op: "process.terminal.configure", id: "pty", revision: 2, attributes: { icrnl: false, opost: false, onlcr: false, icanon: false, echo: false, isig: false, cc: [1, 2, 3, 4, 5, 6, 7] } });',
        });
        expect(agent.output?.result).toEqual({ attributes: raw, revision: 3 });
        const retained = yield* Effect.promise(() => objects.head("process-input/queued/pty.json"));
        for (const controls of ["-1,2,3,4,5,6,7", "256,2,3,4,5,6,7", "1,2"]) {
          const response = yield* Effect.tryPromise(() =>
            fetch(new URL("/v1/sandboxes/queued/action", url), {
              method: "POST",
              keepalive: false,
              headers: {
                authorization: `Bearer ${grant.token}`,
                "content-type": "application/json",
              },
              body: `{"op":"process.terminal.configure","id":"pty","revision":3,"attributes":{"icrnl":false,"opost":false,"onlcr":false,"icanon":false,"echo":false,"isig":false,"cc":[${controls}]}}`,
            }),
          );
          expect(response.status).toBe(400);
          yield* Effect.promise(() => response.text());
        }
        expect(
          (yield* Effect.promise(() => objects.head("process-input/queued/pty.json")))?.etag,
        ).toBe(retained?.etag);
        const expiring = yield* admin.mintCapability("queued", {
          permissions: ["read"],
          expiresInSeconds: 1,
        });
        const temporary = yield* makeBinding(service, Redacted.make(expiring.token));
        expect(
          yield* temporary
            .action("queued", { op: "process.terminal.attributes", id: "pty", timeoutMs: 2000 })
            .pipe(Effect.flip),
        ).toMatchObject({ status: 401 });
        yield* client.action("queued", { op: "process.cancel", id: "pty" });
        expect(
          yield* client
            .action("queued", { op: "process.terminal.attributes", id: "pty", timeoutMs: 0 })
            .pipe(Effect.flip),
        ).toMatchObject({ status: 409 });
      }),
    ).pipe(
      Effect.provide(FetchHttpClient.layer),
      Effect.provideService(FetchHttpClient.RequestInit, { keepalive: false }),
    ),
  ));
