import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Redacted, Schema } from "effect";
import { FetchHttpClient } from "effect/http";
import { make } from "../src/sdk";
import { ProcessDelivery } from "../src/contracts";
import { runtime } from "../tooling/worker-test";
import { commandPackage } from "./fixtures/package";

test(
  "persisted environment is isolated across runtimes, overrides and queued Worker replacement",
  () =>
    Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const directory = yield* Effect.acquireRelease(
            Effect.promise(() => mkdtemp(join(tmpdir(), "boxes-config-env-"))),
            (path) => Effect.promise(() => rm(path, { recursive: true, force: true })),
          );
          const first = yield* Effect.acquireRelease(
            Effect.sync(() => runtime(directory)),
            (worker) => Effect.promise(() => worker.dispose()),
          );
          const url = (yield* Effect.promise(() => first.ready)).toString();
          const admin = yield* make({ url, token: Redacted.make("cirro-local-test-credential") });
          const id = "configured";
          const policy = {
            networkHosts: [],
            interruptBudget: 1000,
            memoryBytes: 8388608,
            maxOutputBytes: 1048576,
          };
          yield* admin.create({
            id,
            policy,
            environment: { CIRRO_MARKER: "configured", ONLY_CONFIG: "private-to-sandbox" },
          });
          const grant = yield* admin.mintCapability(id, {
            permissions: ["read", "write", "execute", "manage"],
            expiresInSeconds: 600,
          });
          const client = yield* make({ url, token: Redacted.make(grant.token) });
          expect((yield* client.action(id, { op: "config.get" })).environment).toEqual({
            CIRRO_MARKER: "configured",
            ONLY_CONFIG: "private-to-sandbox",
          });
          const binary = Buffer.from(
            yield* Effect.promise(() => Bun.file("dist/wasi-inputs.wasm").arrayBuffer()),
          );
          yield* client.action(id, {
            op: "filesystem.writeFile",
            path: "/tmp/package",
            content: commandPackage(binary, "probe", "1.0.0", {
              CIRRO_MARKER: "package",
              ONLY_PACKAGE: "package-only",
            }).toString("base64"),
            encoding: "base64",
          });
          yield* client.action(id, { op: "software.install", source: { path: "/tmp/package" } });
          const js = yield* client.action(id, {
            op: "javascript.evaluate",
            id: "js",
            expression:
              "[process.env.CIRRO_MARKER, process.env.ONLY_PACKAGE, process.env.API_KEY, typeof process.binding]",
          });
          expect(js.output?.result).toEqual(["configured", "package-only", null, "undefined"]);
          const ts = yield* client.action(id, {
            op: "typescript.evaluate",
            id: "ts",
            expression: "process.env.CIRRO_MARKER as string",
            env: { CIRRO_MARKER: "override" },
          });
          expect(ts.output?.result).toBe("override");
          const py = yield* client.action(id, {
            op: "python.evaluate",
            id: "py",
            expression: "__import__('os').getenv('CIRRO_MARKER')",
            env: { CIRRO_MARKER: "python-override" },
          });
          expect(py.output?.result).toBe("python-override");
          const mutation = yield* client.action(id, {
            op: "python.execute",
            id: "py-mutation",
            source:
              "import os\nos.environ['CIRRO_MARKER'] = 'local'\nprint(os.getenv('CIRRO_MARKER'))",
          });
          expect(mutation.output?.stdout).toBe("local\n");
          const fresh = yield* client.action(id, {
            op: "python.evaluate",
            id: "py-fresh",
            expression: "__import__('os').environ['CIRRO_MARKER']",
          });
          expect(fresh.output?.result).toBe("configured");
          const shell = yield* client.action(id, {
            op: "process.run",
            id: "shell",
            language: "shell",
            source: "probe",
          });
          expect(shell.output?.stdout).toContain("configured");
          yield* client.action(id, {
            op: "process.spawn",
            execution: {
              op: "javascript.evaluate",
              id: "queued",
              expression: "process.env.CIRRO_MARKER",
            },
          });
          yield* client.action(id, {
            op: "process.spawn",
            execution: {
              op: "python.evaluate",
              id: "queued-python",
              expression: "__import__('os').getenv('CIRRO_MARKER')",
            },
          });
          yield* client.action(id, {
            op: "process.spawn",
            execution: {
              op: "process.run",
              id: "queued-shell",
              language: "shell",
              source: "probe",
            },
          });
          yield* client.action(id, {
            op: "process.spawn",
            execution: { op: "process.execFile", id: "queued-wasm", command: "probe" },
          });
          yield* client.action(id, {
            op: "config.patch",
            policy: {},
            environment: { CIRRO_MARKER: "next" },
          });
          yield* Effect.promise(() => first.dispose());
          const replacement = yield* Effect.acquireRelease(
            Effect.sync(() => runtime(directory)),
            (worker) => Effect.promise(() => worker.dispose()),
          );
          const nextUrl = (yield* Effect.promise(() => replacement.ready)).toString();
          const next = yield* make({ url: nextUrl, token: Redacted.make(grant.token) });
          expect((yield* next.action(id, { op: "config.get" })).environment).toEqual({
            CIRRO_MARKER: "next",
          });
          const objects = yield* Effect.promise(() => replacement.objects);
          const key = `processes/${id}/queued.json`;
          const queued = yield* Effect.promise(() => objects.head(key));
          if (queued === null) return yield* Effect.die("Missing queued environment snapshot");
          const control = yield* Effect.promise(() => replacement.control);
          yield* Effect.promise(() =>
            control.deliver("executions", [
              {
                id: "environment",
                timestamp: new Date(),
                attempts: 1,
                body: Schema.encodeSync(ProcessDelivery)({ key, eTag: queued.etag }),
              },
            ]),
          );
          expect((yield* next.action(id, { op: "process.get", id: "queued" })).output?.result).toBe(
            "configured",
          );
          for (const processId of ["queued-python", "queued-shell", "queued-wasm"]) {
            const processKey = `processes/${id}/${processId}.json`;
            const receipt = yield* Effect.promise(() => objects.head(processKey));
            if (receipt === null) return yield* Effect.die("Missing interpreter queue snapshot");
            yield* Effect.promise(() =>
              control.deliver("executions", [
                {
                  id: processId,
                  timestamp: new Date(),
                  attempts: 1,
                  body: Schema.encodeSync(ProcessDelivery)({ key: processKey, eTag: receipt.etag }),
                },
              ]),
            );
            const result = yield* next.action(id, { op: "process.get", id: processId });
            expect(result.status).toBe("exited");
            if (processId === "queued-python") expect(result.output?.result).toBe("configured");
            else expect(result.output?.stdout).toContain("configured");
          }
          const latest = yield* next.action(id, {
            op: "javascript.evaluate",
            id: "latest",
            expression: "process.env.CIRRO_MARKER",
          });
          expect(latest.output?.result).toBe("next");
          yield* next.action(id, { op: "config.set", policy });
          expect((yield* next.action(id, { op: "config.get" })).environment).toEqual({
            CIRRO_MARKER: "next",
          });
          yield* next.action(id, {
            op: "config.patch",
            policy: {},
            environment: { CIRRO_MARKER: "" },
          });
          expect(
            (yield* next.action(id, {
              op: "javascript.evaluate",
              id: "empty",
              expression: "process.env.CIRRO_MARKER",
            })).output?.result,
          ).toBe("");
          yield* next.action(id, { op: "config.patch", policy: {}, environment: {} });
          expect(
            (yield* next.action(id, {
              op: "javascript.evaluate",
              id: "cleared",
              expression: "process.env.CIRRO_MARKER",
            })).output?.result,
          ).toBe("package");
          const readerGrant = yield* make({
            url: nextUrl,
            token: Redacted.make("cirro-local-test-credential"),
          }).pipe(
            Effect.flatMap((manager) =>
              manager.mintCapability(id, { permissions: ["read"], expiresInSeconds: 600 }),
            ),
          );
          const reader = yield* make({ url: nextUrl, token: Redacted.make(readerGrant.token) });
          expect(
            yield* reader
              .action(id, { op: "config.patch", policy: {}, environment: { BAD: "bad" } })
              .pipe(Effect.flip),
          ).toMatchObject({ status: 403 });
        }),
      ).pipe(Effect.provide(FetchHttpClient.layer)),
    ),
  20000,
);
