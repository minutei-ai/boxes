import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Redacted } from "effect";
import { FetchHttpClient } from "effect/http";
import { make } from "../src/sdk";
import { runtime } from "../tooling/worker-test";
import { commandPackage } from "./fixtures/package";

test(
  "WASI validates merged environment and UTF-8 budgets before executable blob reads or process reservation",
  () =>
    Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const directory = yield* Effect.acquireRelease(
            Effect.promise(() => mkdtemp(join(tmpdir(), "boxes-env-limits-"))),
            (path) => Effect.promise(() => rm(path, { recursive: true, force: true })),
          );
          const worker = yield* Effect.acquireRelease(
            Effect.sync(() => runtime(directory)),
            (worker) => Effect.promise(() => worker.dispose()),
          );
          const url = (yield* Effect.promise(() => worker.ready)).toString();
          const admin = yield* make({ url, token: Redacted.make("cirro-local-test-credential") });
          const id = "environment-limits";
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
            permissions: ["read", "write", "execute", "manage"],
            expiresInSeconds: 600,
          });
          const client = yield* make({ url, token: Redacted.make(grant.token) });
          const binary = Buffer.from(
            yield* Effect.promise(() => Bun.file("dist/wasi-inputs.wasm").arrayBuffer()),
          );
          const defaults = {
            CIRRO_MARKER: "package",
            ...Object.fromEntries(
              Array.from({ length: 127 }, (_, index) => [`BASE_${index}`, "v"]),
            ),
          };
          yield* client.action(id, {
            op: "filesystem.writeFile",
            path: "/tmp/package",
            content: commandPackage(binary, "probe", "1.0.0", defaults).toString("base64"),
            encoding: "base64",
          });
          yield* client.action(id, { op: "software.install", source: { path: "/tmp/package" } });
          const bucket = yield* Effect.promise(() => worker.objects);
          const firstBlock = binary.subarray(0, 262144);
          const digest = Buffer.from(
            yield* Effect.promise(() => crypto.subtle.digest("SHA-256", firstBlock)),
          ).toString("hex");
          const key = `sandboxes/${id}/blobs/${digest}`;
          expect(yield* Effect.promise(() => bucket.get(key))).not.toBeNull();
          const head = yield* Effect.promise(() => bucket.get(`sandboxes/${id}/head.json`));
          yield* Effect.acquireRelease(
            Effect.promise(() => bucket.delete(key)),
            () => Effect.promise(() => bucket.put(key, firstBlock)),
          );
          const cases = [
            {
              name: "merged-count",
              env: Object.fromEntries(
                Array.from({ length: 128 }, (_, index) => [`CALLER_${index}`, "v"]),
              ),
              error: "E2BIG",
              status: 413,
            },
            {
              name: "merged-bytes",
              env: Object.fromEntries(
                Array.from({ length: 32 }, (_, index) => [`BASE_${index}`, "v".repeat(4096)]),
              ),
              error: "E2BIG",
              status: 413,
            },
            {
              name: "utf8-path",
              env: { PATH: String.fromCharCode(0xd800) },
              error: "EINVAL",
              status: 400,
            },
            {
              name: "utf8-key",
              env: { [String.fromCharCode(0xd800)]: "v" },
              error: "EINVAL",
              status: 400,
            },
            {
              name: "utf8-value",
              env: { CIRRO_MARKER: "é".repeat(4096) },
              error: "EINVAL",
              status: 400,
            },
          ];
          for (const item of cases) {
            expect(
              yield* client
                .action(id, {
                  op: "process.execFile",
                  id: item.name,
                  command: "probe",
                  env: item.env,
                })
                .pipe(Effect.flip),
              item.name,
            ).toMatchObject({ error: item.error, status: item.status });
            expect(
              yield* client.action(id, { op: "process.get", id: item.name }).pipe(Effect.flip),
              item.name,
            ).toMatchObject({ error: "ENOENT", status: 404 });
            expect(
              (yield* Effect.promise(() => bucket.get(`sandboxes/${id}/head.json`)))?.etag,
            ).toBe(head?.etag);
          }
          yield* Effect.promise(() => bucket.put(key, firstBlock));
          const valid = yield* client.action(id, {
            op: "process.execFile",
            id: "override",
            command: "probe",
            args: ["argument"],
            env: { CIRRO_MARKER: "caller" },
          });
          expect(valid.status).toBe("exited");
          expect(valid.output?.exitCode).toBe(0);
          expect(valid.output?.stdout).toContain("caller");
          yield* client.action(id, {
            op: "filesystem.writeFile",
            path: "/tmp/other-package",
            content: commandPackage(binary, "other", "1.0.0", { OTHER: "v" }).toString("base64"),
            encoding: "base64",
          });
          yield* client.action(id, {
            op: "software.install",
            source: { path: "/tmp/other-package" },
          });
          expect(
            yield* client
              .action(id, { op: "process.execFile", id: "package-union", command: "probe" })
              .pipe(Effect.flip),
          ).toMatchObject({ error: "E2BIG", status: 413 });
          expect(
            yield* client.action(id, { op: "process.get", id: "package-union" }).pipe(Effect.flip),
          ).toMatchObject({ error: "ENOENT", status: 404 });
          expect(
            yield* client
              .action(id, {
                op: "process.run",
                id: "shell-union",
                language: "shell",
                source: "probe",
              })
              .pipe(Effect.flip),
          ).toMatchObject({ error: "E2BIG", status: 413 });
        }),
      ).pipe(Effect.provide(FetchHttpClient.layer)),
    ),
  15000,
);
