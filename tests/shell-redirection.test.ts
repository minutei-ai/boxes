import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Redacted } from "effect";
import { FetchHttpClient } from "effect/http";
import { make } from "../src/sdk";
import { runtime } from "../tooling/worker-test";

test(
  "shell redirections open in lexical order before command effects and retain output inode identity",
  () =>
    Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const directory = yield* Effect.acquireRelease(
            Effect.promise(() => mkdtemp(join(tmpdir(), "boxes-shell-redirection-"))),
            (path) => Effect.promise(() => rm(path, { recursive: true, force: true })),
          );
          const worker = yield* Effect.acquireRelease(
            Effect.sync(() => runtime(join(directory, "worker"))),
            (worker) => Effect.promise(() => worker.dispose()),
          );
          const url = (yield* Effect.promise(() => worker.ready)).toString();
          const admin = yield* make({ url, token: Redacted.make("cirro-local-test-credential") });
          const cases = [
            "echo visible 2> file",
            "true 2>> file",
            "false 2> file",
            "cat input 2> first > second",
            "echo 2 > file 2> second",
            "true 2> first 2> second",
            "2> file",
            "cat file > file",
            "cat 0< input 1> file",
            "echo 2 > file",
            'echo 1""> file',
            "echo last > first >> second > file",
            "! > file",
            "false && > untouched; echo safe",
            "cat < file > file",
            "cat > file < file",
            "mkdir should-not-exist > missing/out",
            "true > opened < missing",
            "true < missing > untouched",
            "false > file",
            "missing-command > file",
            "echo retained > first > second",
            "> file",
            "cat < first < second",
            "mv file moved > file",
            "rm file > file",
            "! mkdir should-not-exist > missing/out && echo continued",
            "true >> created",
            "echo appended >> file >> file",
            "cp input file > file",
            "echo x > opened > missing/out",
          ];
          const initial = [
            ["file", "before"],
            ["input", "copied"],
            ["first", "one"],
            ["second", "two"],
          ] as const;
          for (const [index, source] of cases.entries()) {
            const id = `redirect-${index}`;
            const oracleDirectory = join(directory, id);
            yield* Effect.promise(() => mkdir(oracleDirectory));
            for (const [name, content] of initial)
              yield* Effect.promise(() => writeFile(join(oracleDirectory, name), content));
            const oracle = yield* Effect.sync(() =>
              Bun.spawn(["sh", "-c", source], {
                cwd: oracleDirectory,
                stdout: "pipe",
                stderr: "ignore",
              }),
            );
            const stdout = yield* Effect.promise(() => new Response(oracle.stdout).text());
            const exitCode = yield* Effect.promise(() => oracle.exited);
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
              permissions: ["read", "write", "execute"],
              expiresInSeconds: 600,
            });
            const client = yield* make({ url, token: Redacted.make(grant.token) });
            yield* client.action(id, {
              op: "filesystem.writeFiles",
              entries: initial.map(([name, content]) => ({
                path: `/home/cirro/${name}`,
                content,
                encoding: "utf8" as const,
              })),
            });
            const result = yield* client.action(id, {
              op: "process.run",
              id: "run",
              language: "shell",
              source,
            });
            expect(result.output, source).toMatchObject({ stdout, exitCode });
            const names = yield* Effect.promise(() => readdir(oracleDirectory));
            for (const name of [
              "file",
              "input",
              "first",
              "second",
              "opened",
              "untouched",
              "created",
              "moved",
              "should-not-exist",
              "missing",
            ]) {
              const path = `/home/cirro/${name}`;
              const found = yield* client.action(id, { op: "filesystem.exists", path });
              expect(found.exists, `${source}: ${name}`).toBe(names.includes(name));
              if (!found.exists) continue;
              const metadata = yield* Effect.promise(() => stat(join(oracleDirectory, name)));
              if (!metadata.isFile()) continue;
              const file = yield* client.action(id, { op: "filesystem.readFile", path });
              expect(Buffer.from(file.content, file.encoding), `${source}: ${name}`).toEqual(
                yield* Effect.promise(() => readFile(join(oracleDirectory, name))),
              );
            }
          }
          const id = "redirect-authority";
          yield* admin.create({
            id,
            policy: {
              networkHosts: [],
              interruptBudget: 1000,
              memoryBytes: 8388608,
              maxOutputBytes: 1048576,
            },
          });
          const ownerGrant = yield* admin.mintCapability(id, {
            permissions: ["read", "write", "execute"],
            expiresInSeconds: 600,
          });
          const owner = yield* make({ url, token: Redacted.make(ownerGrant.token) });
          const writerGrant = yield* admin.mintCapability(id, {
            permissions: ["write", "execute"],
            expiresInSeconds: 600,
          });
          const writer = yield* make({ url, token: Redacted.make(writerGrant.token) });
          yield* owner.action(id, {
            op: "filesystem.writeFile",
            path: "/tmp/file",
            content: "seed",
            encoding: "utf8",
          });
          yield* owner.action(id, { op: "filesystem.chmod", path: "/tmp/file", mode: 0o200 });
          expect(
            (yield* writer.action(id, {
              op: "process.run",
              id: "append",
              language: "shell",
              source: "echo appended >> /tmp/file",
            })).output,
          ).toMatchObject({ stdout: "", exitCode: 0 });
          yield* owner.action(id, { op: "filesystem.chmod", path: "/tmp/file", mode: 0o600 });
          expect(
            (yield* owner.action(id, { op: "filesystem.readFile", path: "/tmp/file" })).content,
          ).toBe(Buffer.from("seedappended\n").toString("base64"));
          const before = yield* owner.action(id, { op: "vm.status" });
          expect(
            (yield* writer.action(id, {
              op: "process.run",
              id: "append-noop",
              language: "shell",
              source: "true >> /tmp/file",
            })).output?.exitCode,
          ).toBe(0);
          expect((yield* owner.action(id, { op: "vm.status" })).generation).toBe(before.generation);
          yield* owner.action(id, {
            op: "filesystem.link",
            from: "/tmp/file",
            to: "/tmp/alias",
            follow: false,
          });
          expect(
            (yield* owner.action(id, {
              op: "process.run",
              id: "alias-truncate",
              language: "shell",
              source: "cat /tmp/file > /tmp/alias",
            })).output,
          ).toMatchObject({ stdout: "", exitCode: 0 });
          expect(
            (yield* owner.action(id, { op: "filesystem.readFile", path: "/tmp/file" })).content,
          ).toBe("");
          expect(
            (yield* owner.action(id, { op: "filesystem.stat", path: "/tmp/alias", follow: true }))
              .nlink,
          ).toBe(2);
        }),
      ).pipe(Effect.provide(FetchHttpClient.layer)),
    ),
  30000,
);
