import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Redacted } from "effect";
import { FetchHttpClient } from "effect/http";
import { make } from "../src/sdk";
import { runtime } from "../tooling/worker-test";
import { commandPackage } from "./fixtures/package";

test("binary shell preserves cat, WASI pipes, redirections, failure output and denied writes", () =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const directory = yield* Effect.acquireRelease(
          Effect.promise(() => mkdtemp(join(tmpdir(), "boxes-binary-shell-"))),
          (path) => Effect.promise(() => rm(path, { recursive: true, force: true })),
        );
        const worker = yield* Effect.acquireRelease(
          Effect.sync(() => runtime(directory, { consume: true, controlled: false })),
          (worker) => Effect.promise(() => worker.dispose()),
        );
        const url = (yield* Effect.promise(() => worker.ready)).toString();
        const admin = yield* make({ url, token: Redacted.make("cirro-local-test-credential") });
        const id = "binary-shell";
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
          yield* Effect.promise(() => Bun.file("dist/wasi-raw-stdio.wasm").arrayBuffer()),
        );
        const input = Buffer.from(Array.from({ length: 70003 }, (_, index) => index % 256));
        yield* client.action(id, {
          op: "filesystem.writeFile",
          path: "/tmp/input",
          content: input.toString("base64"),
          encoding: "base64",
        });
        yield* client.action(id, {
          op: "filesystem.writeFile",
          path: "/tmp/package",
          content: commandPackage(binary).toString("base64"),
          encoding: "base64",
        });
        yield* client.action(id, { op: "software.install", source: { path: "/tmp/package" } });
        const cases = [
          {
            name: "cat",
            source: "cat /tmp/input > /tmp/cat; cat /tmp/input >> /tmp/cat",
            path: "/tmp/cat",
            expected: Buffer.concat([input, input]),
          },
          {
            name: "generated",
            source: "probe | cat > /tmp/generated",
            path: "/tmp/generated",
            expected: input,
          },
          {
            name: "echo",
            source: "cat /tmp/input | probe echo > /tmp/echo; probe echo < /tmp/input >> /tmp/echo",
            path: "/tmp/echo",
            expected: Buffer.concat([input, input]),
          },
          { name: "exit", source: "probe failure > /tmp/exit", path: "/tmp/exit", expected: input },
          { name: "trap", source: "probe trap > /tmp/trap", path: "/tmp/trap", expected: input },
        ];
        yield* Effect.forEach(cases, (item) =>
          Effect.gen(function* () {
            const record = yield* client.action(id, {
              op: "process.run",
              id: item.name,
              language: "shell",
              source: item.source,
            });
            expect(record.status).toBe("exited");
            expect(record.output?.stdout).toBe("");
            if (item.name === "exit") expect(record.output?.exitCode).toBe(7);
            else if (item.name === "trap") expect(record.output?.exitCode).toBe(126);
            else expect(record.output?.exitCode).toBe(0);
            const file = yield* client.action(id, { op: "filesystem.readFile", path: item.path });
            expect(Buffer.from(file.content, file.encoding)).toEqual(item.expected);
            const page = yield* client.action(id, {
              op: "process.output.read",
              id: item.name,
              after: null,
              maxBytes: 65536,
              maxEvents: 128,
            });
            const stderr = Buffer.concat(
              page.events
                .filter((event) => event.stream === "stderr")
                .map((event) => Buffer.from(event.data, "base64")),
            );
            if (item.name === "generated" || item.name === "exit")
              expect(stderr).toEqual(Buffer.from([255, 0, 128, 195, 40, 254]));
            if (item.name === "trap") {
              expect(stderr.subarray(0, 6)).toEqual(Buffer.from([255, 0, 128, 195, 40, 254]));
              expect(stderr.subarray(6).toString()).toContain("WASI execution failed");
            }
          }),
        );
        const visible = yield* client.action(id, {
          op: "process.run",
          id: "visible",
          language: "shell",
          source: "cat /tmp/input | probe echo | cat",
        });
        expect(visible.output?.exitCode).toBe(0);
        const first = yield* client.action(id, {
          op: "process.output.read",
          id: "visible",
          after: null,
          maxBytes: 65536,
          maxEvents: 128,
        });
        const second = yield* client.action(id, {
          op: "process.output.read",
          id: "visible",
          after: first.nextCursor,
          maxBytes: 65536,
          maxEvents: 128,
        });
        expect(
          Buffer.concat(
            [...first.events, ...second.events].map((event) => Buffer.from(event.data, "base64")),
          ),
        ).toEqual(input);
        const readonly = yield* admin.mintCapability(id, {
          permissions: ["read", "execute"],
          expiresInSeconds: 600,
        });
        const reader = yield* make({ url, token: Redacted.make(readonly.token) });
        const denied = yield* reader.action(id, {
          op: "process.run",
          id: "denied",
          language: "shell",
          source: "cat /tmp/input > /tmp/denied",
        });
        expect(denied.output?.exitCode).toBe(1);
        const exists = yield* client.action(id, { op: "filesystem.exists", path: "/tmp/denied" });
        expect(exists.exists).toBe(false);
        yield* client.action(id, {
          op: "filesystem.writeFile",
          path: "/tmp/large",
          content: Buffer.alloc(1048577, 255).toString("base64"),
          encoding: "base64",
        });
        const quota = yield* client.action(id, {
          op: "process.run",
          id: "quota",
          language: "shell",
          source: "cat /tmp/large > /tmp/over-quota",
        });
        expect(quota.output?.exitCode).toBe(1);
        expect(quota.output?.stderr).toContain("byte quota");
        expect(
          (yield* client.action(id, { op: "filesystem.exists", path: "/tmp/over-quota" })).exists,
        ).toBe(false);
        const filterInput = Buffer.from([
          65, 255, 0, 13, 10, 98, 128, 10, 98, 128, 10, 195, 169, 32, 120,
        ]);
        yield* client.action(id, {
          op: "filesystem.writeFile",
          path: "/tmp/filter-input",
          content: filterInput.toString("base64"),
          encoding: "base64",
        });
        const filters = [
          { name: "head-lines", command: "head", args: ["-n", "2"], source: "head -n 2" },
          { name: "tail-lines", command: "tail", args: ["-n", "2"], source: "tail -n 2" },
          { name: "head-bytes", command: "head", args: ["-c", "3"], source: "head -c 3" },
          { name: "tail-bytes", command: "tail", args: ["-c", "4"], source: "tail -c 4" },
          { name: "head-zero", command: "head", args: ["-n", "0"], source: "head -n 0" },
          { name: "tail-zero", command: "tail", args: ["-n", "0"], source: "tail -n 0" },
          { name: "wc-bytes", command: "wc", args: ["-c"], source: "wc -c" },
          { name: "wc-lines", command: "wc", args: ["-l"], source: "wc -l" },
          { name: "wc-words", command: "wc", args: ["-w"], source: "wc -w" },
          { name: "sort", command: "sort", args: [], source: "sort" },
          { name: "uniq", command: "uniq", args: [], source: "uniq" },
          { name: "grep", command: "grep", args: ["-a", "^A"], source: "grep '^A'" },
        ];
        yield* Effect.forEach(filters, (item) =>
          Effect.gen(function* () {
            const oracle = yield* Effect.sync(() =>
              Bun.spawnSync({
                cmd: [`/usr/bin/${item.command}`, ...item.args],
                stdin: Buffer.from(
                  Uint8Array.from(filterInput).map((byte) => {
                    if (item.name !== "wc-words") return byte;
                    if ([9, 10, 11, 12, 13, 32].includes(byte)) return byte;
                    return 120;
                  }),
                ),
                stdout: "pipe",
                stderr: "pipe",
                env: { LC_ALL: "C" },
              }),
            );
            expect(oracle.exitCode).toBe(0);
            const record = yield* client.action(id, {
              op: "process.run",
              id: item.name,
              language: "shell",
              source: `${item.source} < /tmp/filter-input > /tmp/filter-output`,
            });
            expect(record.output?.exitCode).toBe(0);
            const file = yield* client.action(id, {
              op: "filesystem.readFile",
              path: "/tmp/filter-output",
            });
            const actual = Buffer.from(file.content, file.encoding);
            if (item.command === "wc")
              expect(actual.toString().trim()).toBe(Buffer.from(oracle.stdout).toString().trim());
            else expect(actual).toEqual(Buffer.from(oracle.stdout));
          }),
        );
        const invalid = yield* client.action(id, {
          op: "process.run",
          id: "invalid-filter",
          language: "shell",
          source: "wc -c ignored < /tmp/filter-input",
        });
        expect(invalid.output?.exitCode).toBe(2);
        yield* client.action(id, { op: "vm.dispose" });
      }),
    ).pipe(Effect.provide(FetchHttpClient.layer)),
  ));
