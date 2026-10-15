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
  "native shell variables retain local and exported scope without changing persisted configuration",
  () =>
    Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const directory = yield* Effect.acquireRelease(
            Effect.promise(() => mkdtemp(join(tmpdir(), "boxes-shell-variables-"))),
            (path) => Effect.promise(() => rm(path, { recursive: true, force: true })),
          );
          const worker = yield* Effect.acquireRelease(
            Effect.sync(() => runtime(directory)),
            (worker) => Effect.promise(() => worker.dispose()),
          );
          const url = (yield* Effect.promise(() => worker.ready)).toString();
          const admin = yield* make({ url, token: Redacted.make("cirro-local-test-credential") });
          const id = "variables";
          const environment = {
            HOME: "/tmp/captured home",
            VALUE: " two words ",
            CIRRO_MARKER: "configured",
          };
          yield* admin.create({
            id,
            environment,
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
          const cases = [
            'A=~:~/bin:/bin:~; echo "$A"',
            'export A=~/file; echo "$A"',
            'readonly A=~; echo "$A"',
            'HOME="/tmp/new home" A=~/file; echo "$A"',
            'A=~; HOME=/tmp/new; echo "$A"',
            'A=old; A=~/file echo "$A"; echo "$A"',
            "A='prefix':~; echo \"$A\"",
            "A=prefix:''~; echo \"$A\"",
            "A=prefix:~''; echo \"$A\"",
            'VALUE=":~"; A=$VALUE; echo "$A"',
            'A=old; false && A=~root; echo "$A"',
            'A=old; A=~ | cat; echo "$A"',
            'A=one; unset -v -- A; echo "[$A]"',
            'false; A=$?; echo "$A:$?"',
            'A=old; A=new export B=$A; echo "$A:$B"',
            'CMD=export; $CMD A=$VALUE; echo "[$A]"',
            '\"export\" A=$VALUE; echo "[$A]"',
            'ex\"port\" A=$VALUE; echo "[$A]"',
            'A=one; echo "$A"',
            "A='two words'; echo \"$A\"; echo $A",
            'A=one B=$A; echo "$A:$B"',
            'A=old; A=new echo "$A"; echo "$A"',
            'A=old; A=new :; echo "$A"',
            'A=old; false && A=skipped; echo "$A"',
            'A=old; true || A=skipped; echo "$A"',
            'A=old; A=new | cat; echo "$A"',
            'A=old; export A=new | cat; echo "$A"',
            'A=one; export A; A=two; echo "$A"; unset A; echo "[$A]"',
            'A=old; unset A; A=new; echo "$A"',
            "export A='two words'; echo \"$A\"",
            'export A=$VALUE; echo "$A"',
            "export A='*'; echo \"$A\"",
            "export A B='b'; A=a; echo \"$A:$B\"",
            'A=one; unset -v A; echo "[$A]"',
            'A=one; unset -- A; echo "[$A]"',
            "A=''; echo \"[$A]\"",
            "A='; echo injected'; echo \"$A\"",
            "A='$VALUE'; echo \"$A\"",
            'A=one; ! A=two; echo "$A:$?"',
            'A=one; false | A=two; echo "$A:$?"',
            "HOME=/tmp; cd; pwd",
          ];
          yield* Effect.forEach(cases, (source, index) =>
            Effect.gen(function* () {
              const oracle = yield* Effect.sync(() =>
                Bun.spawn(["sh", "-c", source], {
                  env: { PATH: "/usr/bin:/bin", ...environment },
                  stdout: "pipe",
                  stderr: "pipe",
                }),
              );
              const [stdout, stderr, exitCode] = yield* Effect.promise(() =>
                Promise.all([
                  new Response(oracle.stdout).text(),
                  new Response(oracle.stderr).text(),
                  oracle.exited,
                ]),
              );
              const result = yield* client.action(id, {
                op: "process.run",
                id: `case-${index}`,
                language: "shell",
                source,
              });
              expect(
                {
                  stdout: result.output?.stdout,
                  stderr: result.output?.stderr,
                  exitCode: result.output?.exitCode,
                },
                source,
              ).toEqual({ stdout, stderr, exitCode });
            }),
          );
          const binary = Buffer.from(
            yield* Effect.promise(() => Bun.file("dist/wasi-inputs.wasm").arrayBuffer()),
          );
          yield* client.action(id, {
            op: "filesystem.writeFile",
            path: "/tmp/package",
            content: commandPackage(binary, "probe", "1.0.0", {}).toString("base64"),
            encoding: "base64",
          });
          yield* client.action(id, { op: "software.install", source: { path: "/tmp/package" } });
          const externalCases = [
            { source: "unset CIRRO_MARKER; CIRRO_MARKER=local :; probe", markers: ["local"] },
            { source: "unset CIRRO_MARKER; CIRRO_MARKER=local export; probe", markers: ["unset"] },
            { source: "CIRRO_MARKER=local probe; probe", markers: ["local", "configured"] },
            {
              source: "unset CIRRO_MARKER; CIRRO_MARKER=local; probe; export CIRRO_MARKER; probe",
              markers: ["unset", "local"],
            },
            {
              source: "unset CIRRO_MARKER; export CIRRO_MARKER; CIRRO_MARKER=after; probe",
              markers: ["after"],
            },
            { source: "CIRRO_MARKER=local true; probe", markers: ["configured"] },
            { source: "CIRRO_MARKER=local :; probe", markers: ["local"] },
            {
              source: "CIRRO_MARKER=before; export CIRRO_MARKER=after | cat; probe",
              markers: ["before"],
            },
            {
              source: "PATH=/missing probe; /opt/cirro/pkgs/probe/1.0.0/bin/probe",
              markers: ["configured"],
            },
          ];
          yield* Effect.forEach(externalCases, (item, index) =>
            Effect.gen(function* () {
              const result = yield* client.action(id, {
                op: "process.run",
                id: `external-${index}`,
                language: "shell",
                source: item.source,
              });
              expect(result.output?.exitCode, item.source).toBe(0);
              expect(
                result.output?.stdout
                  .split("\n")
                  .filter((line) => line.startsWith("marker="))
                  .map((line) => line.slice(7)),
                item.source,
              ).toEqual(item.markers);
            }),
          );
          const redirect = yield* client.action(id, {
            op: "process.run",
            id: "redirect-scope",
            language: "shell",
            source:
              'TARGET=/tmp/old; TARGET=/tmp/new echo ok > "$TARGET"; cat /tmp/old; echo "$TARGET"',
          });
          expect(redirect.output?.stdout).toBe("ok\n/tmp/old\n");
          const only = yield* client.action(id, {
            op: "process.run",
            id: "assignment-only",
            language: "shell",
            source: 'A="retained value" >/tmp/empty; echo "$A"',
          });
          expect(only.output?.stdout).toBe("retained value\n");
          yield* Effect.forEach(["unset HOME; A=~", "A=~root/file", "A=~/file"], (source, index) =>
            Effect.gen(function* () {
              const result = yield* client.action(id, {
                op: "process.run",
                id: `tilde-rejection-${index}`,
                language: "shell",
                source: `${source} echo unreachable >/tmp/tilde-rejection-${index}`,
                env: { HOME: "x".repeat(4096) },
              });
              expect(result.output?.exitCode).toBe(1);
              expect(result.output?.stdout).toBe("");
              if (index === 2) {
                expect(result.output?.stderr).toContain("EFBIG");
              } else {
                expect(result.output?.stderr).toContain("ENOTSUP");
              }
              expect(
                (yield* client.action(id, {
                  op: "filesystem.exists",
                  path: `/tmp/tilde-rejection-${index}`,
                })).exists,
              ).toBe(false);
            }),
          );
          const tooLarge = yield* client.action(id, {
            op: "process.run",
            id: "value-quota",
            language: "shell",
            source: `A=${"x".repeat(4097)} echo unreachable >/tmp/quota-output`,
          });
          expect(tooLarge.output?.exitCode).toBe(1);
          expect(tooLarge.output?.stderr).toContain("EFBIG");
          expect(
            (yield* client.action(id, { op: "filesystem.exists", path: "/tmp/quota-output" }))
              .exists,
          ).toBe(false);
          const tooMany = yield* client.action(id, {
            op: "process.run",
            id: "variable-quota",
            language: "shell",
            source: `${Array.from({ length: 127 }, (_, index) => `V${index}=x`).join(" ")} echo unreachable`,
          });
          expect(tooMany.output?.exitCode).toBe(1);
          expect(tooMany.output?.stdout).toBe("");
          const totalBytes = yield* client.action(id, {
            op: "process.run",
            id: "argument-quota",
            language: "shell",
            source: `echo ${Array.from({ length: 257 }, () => "$BIG").join(" ")}`,
            env: { BIG: "x".repeat(4096) },
          });
          expect(totalBytes.output?.exitCode).toBe(1);
          expect(totalBytes.output?.stdout).toBe("");
          const readGrant = yield* admin.mintCapability(id, {
            permissions: ["read", "execute"],
            expiresInSeconds: 600,
          });
          const readonly = yield* make({ url, token: Redacted.make(readGrant.token) });
          const localOnly = yield* readonly.action(id, {
            op: "process.run",
            id: "readonly",
            language: "shell",
            source: 'A=~/local; export A; readonly A; echo "$A"',
          });
          expect(localOnly.output?.stdout).toBe("/tmp/captured home/local\n");
          const exportedQuota = yield* client.action(id, {
            op: "process.run",
            id: "exported-quota",
            language: "shell",
            source: `export ${Array.from({ length: 127 }, (_, index) => `V${index}`).join(" ")}; echo unreachable`,
          });
          expect(exportedQuota.output?.exitCode).toBe(2);
          expect(exportedQuota.output?.stdout).toBe("");
          const fieldSeparators = yield* client.action(id, {
            op: "process.run",
            id: "unsupported-ifs",
            language: "shell",
            source: "IFS=: echo unreachable",
          });
          expect(fieldSeparators.output?.exitCode).toBe(1);
          expect(fieldSeparators.output?.stderr).toContain("ENOTSUP");
          const pipelineCwd = yield* client.action(id, {
            op: "process.run",
            id: "pipeline-cwd",
            language: "shell",
            source: "cd /tmp | cat; pwd",
          });
          expect(pipelineCwd.output?.stdout).toBe("/home/cirro\n");
          const listed = yield* client.action(id, {
            op: "process.run",
            id: "export-listing",
            language: "shell",
            source: `export A="a'b"; export -p`,
          });
          const listingOracle = yield* Effect.sync(() =>
            Bun.spawn(["sh", "-c", `${listed.output?.stdout}\nprintf '%s' "$A"`], {
              env: { PATH: "/usr/bin:/bin" },
              stdout: "pipe",
              stderr: "pipe",
            }),
          );
          expect(yield* Effect.promise(() => new Response(listingOracle.stdout).text())).toBe(
            "a'b",
          );
          expect(yield* Effect.promise(() => listingOracle.exited)).toBe(0);
          const invalid = yield* client.action(id, {
            op: "process.run",
            id: "invalid-export",
            language: "shell",
            source: "export bad-name; echo unreachable",
          });
          expect(invalid.output?.exitCode).toBe(2);
          expect(invalid.output?.stdout).toBe("");
          const quotedName = yield* client.action(id, {
            op: "process.run",
            id: "quoted-name",
            language: "shell",
            source: 'A"B"=value',
          });
          expect(quotedName.output?.exitCode).toBe(127);
          expect((yield* client.action(id, { op: "config.get" })).environment).toEqual(environment);
          const separate = yield* client.action(id, {
            op: "process.run",
            id: "separate",
            language: "shell",
            source: 'echo "[$A]"; probe',
          });
          expect(separate.output?.stdout).toContain("[]\n");
          expect(separate.output?.stdout).toContain("marker=configured\n");
          const queued = yield* client.action(id, {
            op: "process.spawn",
            execution: {
              op: "process.run",
              id: "queued",
              language: "shell",
              source:
                'A=~/saved; echo "$A"; probe; CIRRO_MARKER=queued; export CIRRO_MARKER; readonly CIRRO_MARKER; probe',
            },
          });
          expect(queued.status).toBe("queued");
          const objects = yield* Effect.promise(() => worker.objects);
          const key = `processes/${id}/queued.json`;
          const receipt = yield* Effect.promise(() => objects.head(key));
          if (receipt === null) return yield* Effect.die("Missing queued shell receipt");
          yield* client.action(id, {
            op: "config.patch",
            policy: {},
            environment: { CIRRO_MARKER: "later" },
          });
          yield* Effect.promise(() => worker.dispose());
          const replacement = yield* Effect.acquireRelease(
            Effect.sync(() => runtime(directory)),
            (worker) => Effect.promise(() => worker.dispose()),
          );
          const nextUrl = (yield* Effect.promise(() => replacement.ready)).toString();
          const next = yield* make({ url: nextUrl, token: Redacted.make(grant.token) });
          const control = yield* Effect.promise(() => replacement.control);
          yield* Effect.promise(() =>
            control.deliver("executions", [
              {
                id: "queued",
                timestamp: new Date(),
                attempts: 1,
                body: Schema.encodeSync(ProcessDelivery)({ key, eTag: receipt.etag }),
              },
            ]),
          );
          const finished = yield* next.action(id, { op: "process.get", id: "queued" });
          expect(finished.output?.stdout).toContain("/tmp/captured home/saved\n");
          expect(finished.output?.stdout).toContain("marker=configured\n");
          expect(finished.output?.stdout).toContain("marker=queued\n");
          expect((yield* next.action(id, { op: "config.get" })).environment).toEqual({
            CIRRO_MARKER: "later",
          });
          yield* next.action(id, { op: "vm.dispose" });
        }),
      ).pipe(Effect.provide(FetchHttpClient.layer)),
    ),
  30000,
);
