import { expect, test } from "bun:test";
import { Effect, Redacted } from "effect";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeBinding } from "../src/sdk";
import { runtime } from "../tooling/worker-test";

const policy = {
  networkHosts: [],
  interruptBudget: 1000,
  memoryBytes: 8_388_608,
  maxOutputBytes: 1_048_576,
};

const connect = Effect.fn("pythonFilesystemTest.connect")(function* (directory: string) {
  const worker = yield* Effect.acquireRelease(
    Effect.sync(() => runtime(directory, { controlled: false })),
    (value) => Effect.promise(() => value.dispose()),
  );
  const service = yield* Effect.promise(() => worker.service);
  return {
    service,
    admin: yield* makeBinding(service, Redacted.make("cirro-local-test-credential")),
  };
});

test(
  "native binding Python imports source, packages, namespaces, cycles and failed-module replacement",
  () =>
    Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const directory = yield* Effect.acquireRelease(
            Effect.promise(() => mkdtemp(join(tmpdir(), "boxes-python-filesystem-"))),
            (path) => Effect.promise(() => rm(path, { recursive: true, force: true })),
          );
          const native = yield* connect(directory);
          yield* native.admin.create({ id: "imports", policy });
          const grant = yield* native.admin.mintCapability("imports", {
            permissions: ["read", "write", "execute", "manage"],
            expiresInSeconds: 3600,
          });
          const client = yield* makeBinding(native.service, Redacted.make(grant.token));
          for (const path of ["/tmp/pkg", "/one/space", "/two/space"])
            yield* client.action("imports", { op: "filesystem.mkdir", path, recursive: true });
          for (const [path, content] of [
            ["/tmp/helper.py", "print('loaded')\nlabel='ação'\nanswer=42\n"],
            ["/tmp/pkg/__init__.py", "from .leaf import answer\n"],
            ["/tmp/pkg/leaf.py", "answer=42\n"],
            ["/tmp/cycle_a.py", "seed=41\nfrom cycle_b import answer\n"],
            ["/tmp/cycle_b.py", "from cycle_a import seed\nanswer=seed+1\n"],
            ["/one/space/a.py", "answer=20\n"],
            ["/two/space/b.py", "answer=22\n"],
            ["/tmp/broken.py", "raise ValueError('first import')\n"],
          ] as const)
            yield* client.action("imports", {
              op: "filesystem.writeFile",
              path,
              content,
              encoding: "utf8",
            });
          yield* client.action("imports", {
            op: "filesystem.writeFile",
            path: "/tmp/latin.py",
            encoding: "base64",
            content: Buffer.from("# coding: latin-1\nlabel='café'\n", "latin1").toString("base64"),
          });
          yield* client.action("imports", {
            op: "filesystem.symlink",
            path: "/tmp/pkg.py",
            target: "/tmp/pkg.py",
          });
          const paths = ["/tmp/helper.py", "/tmp/pkg.py", "/tmp/absent.py"];
          const stats = yield* client.action("imports", {
            op: "filesystem.statFiles",
            paths,
            follow: true,
          });
          expect(stats).toMatchObject([
            { path: paths[0], stat: { kind: "file" } },
            { path: paths[1], stat: null, code: "ELOOP" },
            { path: paths[2], stat: null, code: "ENOENT" },
          ]);
          const aliases = yield* client.action("imports", {
            op: "filesystem.statFiles",
            paths: ["/tmp/pkg.py"],
            follow: false,
          });
          expect(aliases).toMatchObject([{ path: "/tmp/pkg.py", stat: { kind: "symlink" } }]);
          const source = yield* client.action("imports", {
            op: "python.execute",
            id: "source",
            filePath: "/tmp/main.py",
            source:
              "import helper\nagain=__import__('helper')\n[helper.answer,helper.label,helper.__file__,helper is again]",
          });
          expect(source.output).toEqual({
            stdout: "loaded\n",
            stderr: "",
            exitCode: 0,
            result: [42, "ação", "/tmp/helper.py", true],
          });
          const packages = yield* client.action("imports", {
            op: "python.execute",
            id: "packages",
            filePath: "/tmp/main.py",
            source:
              "import pkg, cycle_a, latin\n[pkg.answer,pkg.leaf.__package__,cycle_a.answer,latin.label,pkg.__path__]",
          });
          expect(packages.output?.stderr).toBe("");
          expect(packages.output?.exitCode).toBe(0);
          expect(packages.output?.result).toEqual([42, "pkg", 42, "café", ["/tmp/pkg"]]);
          yield* native.admin.create({
            id: "stdlib",
            policy: { ...policy, interruptBudget: 100_000 },
          });
          const stdlibGrant = yield* native.admin.mintCapability("stdlib", {
            permissions: ["read", "write", "execute"],
            expiresInSeconds: 3600,
          });
          const stdlib = yield* makeBinding(native.service, Redacted.make(stdlibGrant.token));
          yield* stdlib.action("stdlib", {
            op: "filesystem.writeFile",
            path: "/tmp/native_libs.py",
            encoding: "utf8",
            content:
              "import json,re\nanswer=json.loads('{\"value\":42}')[\"value\"]\nwords=re.findall('[a-z]+','box 42 native')\n",
          });
          const standard = yield* stdlib.action("stdlib", {
            op: "python.execute",
            id: "standard",
            filePath: "/tmp/main.py",
            source: "import native_libs\n[native_libs.answer,native_libs.words]",
          });
          expect(standard.output?.stderr).toBe("");
          expect(standard.output?.result).toEqual([42, ["box", "native"]]);
          const namespaces = yield* client.action("imports", {
            op: "python.execute",
            id: "namespaces",
            filePath: "/one/main.py",
            source:
              "import sys\nsys.path.append('/two')\nfrom space import a,b\n[a.answer+b.answer,list(__import__('space').__path__)]",
          });
          expect(namespaces.output?.stderr).toBe("");
          expect(namespaces.output?.result).toEqual([42, ["/one/space", "/two/space"]]);
          const retry = yield* client.action("imports", {
            op: "python.execute",
            id: "retry",
            filePath: "/tmp/main.py",
            source:
              "import sys\ntry:\n import broken\nexcept ValueError:\n removed='broken' not in sys.modules\nawait tools.call({'op':'filesystem.writeFile','path':'/tmp/broken.py','content':'answer=42\\n','encoding':'utf8'})\nimport broken\ntry:\n import missing\nexcept ModuleNotFoundError:\n absent='missing' not in sys.modules\n[removed,broken.answer,absent]",
          });
          expect(retry.output?.stderr).toBe("");
          expect(retry.output?.result).toEqual([true, 42, true]);
          yield* native.admin.create({ id: "sibling", policy });
          const siblingGrant = yield* native.admin.mintCapability("sibling", {
            permissions: ["read", "write", "execute"],
            expiresInSeconds: 3600,
          });
          const sibling = yield* makeBinding(native.service, Redacted.make(siblingGrant.token));
          yield* sibling.action("sibling", {
            op: "filesystem.writeFile",
            path: "/tmp/helper.py",
            content: "answer=900\n",
            encoding: "utf8",
          });
          const isolated = yield* sibling.action("sibling", {
            op: "python.execute",
            id: "isolated",
            filePath: "/tmp/main.py",
            source: "import helper\nhelper.answer",
          });
          expect(isolated.output?.stderr).toBe("");
          expect(isolated.output?.result).toBe(900);
          const original = yield* client.action("imports", {
            op: "python.execute",
            id: "original",
            filePath: "/tmp/main.py",
            source: "import helper\nhelper.answer",
          });
          expect(original.output?.stderr).toBe("");
          expect(original.output?.result).toBe(42);
        }),
      ),
    ),
  30000,
);

test(
  "R2-retained Python modules survive closed Workers and honor current grants before new imports",
  () =>
    Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const directory = yield* Effect.acquireRelease(
            Effect.promise(() => mkdtemp(join(tmpdir(), "boxes-python-import-recovery-"))),
            (path) => Effect.promise(() => rm(path, { recursive: true, force: true })),
          );
          const grants = yield* Effect.scoped(
            Effect.gen(function* () {
              const native = yield* connect(directory);
              yield* native.admin.create({ id: "retained", policy });
              const full = yield* native.admin.mintCapability("retained", {
                permissions: ["read", "write", "execute", "manage"],
                expiresInSeconds: 3600,
              });
              const reduced = yield* native.admin.mintCapability("retained", {
                permissions: ["read", "execute"],
                expiresInSeconds: 3600,
              });
              const noRead = yield* native.admin.mintCapability("retained", {
                permissions: ["execute"],
                expiresInSeconds: 3600,
              });
              const client = yield* makeBinding(native.service, Redacted.make(full.token));
              yield* client.action("retained", {
                op: "contexts.create",
                id: "state",
                language: "python",
              });
              yield* client.action("retained", {
                op: "filesystem.writeFile",
                path: "/tmp/counter.py",
                encoding: "utf8",
                content:
                  "import _boxes_io\nsaved_call=_boxes_io.call\nvalue=40\ndef next():\n global value\n value+=1\n return value\ndef write():\n return saved_call({'op':'filesystem.writeFile','path':'/tmp/cached-denied','content':'denied','encoding':'utf8'})\n",
              });
              yield* client.action("retained", {
                op: "filesystem.writeFile",
                path: "/tmp/fresh.py",
                encoding: "utf8",
                content:
                  "import _boxes_io\n_boxes_io.call({'op':'filesystem.writeFile','path':'/tmp/denied-marker','content':'denied','encoding':'utf8'})\nanswer=42\n",
              });
              const seeded = yield* client.action("retained", {
                op: "python.execute",
                id: "seed",
                contextId: "state",
                filePath: "/tmp/main.py",
                source: "import counter\ncounter.next()",
              });
              expect(seeded.output?.stderr).toBe("");
              expect(seeded.output?.result).toBe(41);
              return { full: full.token, reduced: reduced.token, noRead: noRead.token };
            }),
          );
          yield* Effect.scoped(
            Effect.gen(function* () {
              const native = yield* connect(directory);
              const noRead = yield* makeBinding(native.service, Redacted.make(grants.noRead));
              const rejected = yield* noRead
                .action("retained", {
                  op: "python.evaluate",
                  id: "no-read",
                  contextId: "state",
                  expression: "counter.next()",
                })
                .pipe(Effect.result);
              expect(rejected._tag).toBe("Failure");
              if (rejected._tag === "Failure")
                expect(rejected.failure).toMatchObject({
                  _tag: "BoxesError",
                  status: 403,
                  error: "FORBIDDEN",
                });
              const noReadStats = yield* noRead
                .action("retained", {
                  op: "filesystem.statFiles",
                  paths: ["/tmp/counter.py"],
                  follow: true,
                })
                .pipe(Effect.result);
              expect(noReadStats._tag).toBe("Failure");
              if (noReadStats._tag === "Failure")
                expect(noReadStats.failure).toMatchObject({
                  _tag: "BoxesError",
                  status: 403,
                  error: "FORBIDDEN",
                });
              const client = yield* makeBinding(native.service, Redacted.make(grants.reduced));
              const cached = yield* client.action("retained", {
                op: "python.evaluate",
                id: "cached",
                contextId: "state",
                expression: "counter.next()",
              });
              expect(cached.output?.stderr).toBe("");
              expect(cached.output?.result).toBe(42);
              const denied = yield* client.action("retained", {
                op: "python.execute",
                id: "denied",
                contextId: "state",
                source:
                  "import sys\ntry:\n counter.write()\nexcept PermissionError as error:\n cached_denied=error.error\ntry:\n import fresh\nexcept PermissionError as error:\n denied=error.error\n[counter.next(),cached_denied,denied,'fresh' not in sys.modules]",
              });
              expect(denied.output?.stderr).toBe("");
              expect(denied.output?.result).toEqual([43, "FORBIDDEN", "FORBIDDEN", true]);
              const owner = yield* makeBinding(native.service, Redacted.make(grants.full));
              expect(
                (yield* owner.action("retained", {
                  op: "filesystem.exists",
                  path: "/tmp/denied-marker",
                })).exists,
              ).toBe(false);
              expect(
                (yield* owner.action("retained", {
                  op: "filesystem.exists",
                  path: "/tmp/cached-denied",
                })).exists,
              ).toBe(false);
              yield* owner.action("retained", {
                op: "filesystem.writeFile",
                path: "/tmp/counter.py",
                encoding: "utf8",
                content: "value=900\ndef next():\n global value\n value+=1\n return value\n",
              });
            }),
          );
          const native = yield* connect(directory);
          const client = yield* makeBinding(native.service, Redacted.make(grants.full));
          const retained = yield* client.action("retained", {
            op: "python.evaluate",
            id: "retained",
            contextId: "state",
            expression: "counter.next()",
          });
          expect(retained.output?.stderr).toBe("");
          expect(retained.output?.result).toBe(44);
          yield* client.action("retained", { op: "contexts.reset", id: "state" });
          const reset = yield* client.action("retained", {
            op: "python.execute",
            id: "reset",
            contextId: "state",
            filePath: "/tmp/main.py",
            source: "import counter\ncounter.next()",
          });
          expect(reset.output?.stderr).toBe("");
          expect(reset.output?.result).toBe(901);
        }),
      ),
    ),
  30000,
);
