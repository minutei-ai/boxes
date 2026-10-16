import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Redacted, Schema } from "effect";
import { FetchHttpClient } from "effect/http";
import { make } from "../src/sdk";
import { runtime } from "../tooling/worker-test";
import { ContextBindingProof } from "./fixtures/sdk-binding-worker";
import { Id } from "../src/contracts";
import { ContextClaimProof } from "./fixtures/context-checkpoint-contract";

const policy = {
  networkHosts: [],
  interruptBudget: 1000,
  memoryBytes: 8_388_608,
  maxOutputBytes: 1_048_576,
};
const connect = Effect.fn("contextTest.connect")(function* (
  directory: string,
  token = "cirro-local-test-credential",
) {
  const worker = yield* Effect.acquireRelease(
    Effect.sync(() => runtime(directory, { controlled: false })),
    (worker) => Effect.promise(() => worker.dispose()),
  );
  const url = (yield* Effect.promise(() => worker.ready)).toString();
  return { worker, url, client: yield* make({ url, token: Redacted.make(token) }) };
});

test(
  "public contexts retain native state through replacement, shared JS/TS execution, reset and delete",
  () =>
    Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const directory = yield* Effect.acquireRelease(
            Effect.promise(() => mkdtemp(join(tmpdir(), "boxes-context-api-"))),
            (path) => Effect.promise(() => rm(path, { recursive: true, force: true })),
          );
          const token = yield* Effect.scoped(
            Effect.gen(function* () {
              const first = yield* connect(directory);
              yield* first.client.create({ id: "contexts", policy });
              const grant = yield* first.client.mintCapability("contexts", {
                permissions: ["read", "write", "execute", "manage"],
                expiresInSeconds: 3600,
              });
              const boxes = yield* make({ url: first.url, token: Redacted.make(grant.token) });
              expect(
                (yield* boxes.action("contexts", { op: "contexts.create", id: "analysis" })).state,
              ).toBe("idle");
              yield* boxes.action("contexts", {
                op: "filesystem.writeFile",
                path: "/tmp/counter.js",
                content: "let count=0;export const next=()=>++count;",
                encoding: "utf8",
              });
              const initialized = yield* boxes.action("contexts", {
                op: "javascript.execute",
                id: "seed",
                source:
                  "import {next} from './counter.js'; let value=40; globalThis.bump=()=>++value; globalThis.log=console.log; globalThis.nextModule=next; globalThis.dynamicNext=()=>import('./counter.js').then(module=>module.next());",
                filePath: "/tmp/state.mjs",
                contextId: "analysis",
              });
              expect(initialized.status).toBe("exited");
              const firstValue = yield* boxes.action("contexts", {
                op: "javascript.evaluate",
                id: "first",
                expression: "({value:globalThis.bump(),module:globalThis.nextModule()})",
                contextId: "analysis",
              });
              expect(firstValue.output?.result).toEqual({ value: 41, module: 1 });
              const imported = yield* boxes.action("contexts", {
                op: "process.run",
                id: "created-dependency",
                contextId: "analysis",
                language: "javascript",
                source:
                  "export default async({tools})=>{await tools.call({op:'filesystem.writeFile',path:'/tmp/from-turn.js',content:'export const value=7;',encoding:'utf8'});const name='./from-turn.js';return(await import(name)).value;}",
              });
              expect(imported.output?.result).toBe(7);

              return grant.token;
            }),
          );
          const second = yield* connect(directory, token);
          const boxes = second.client;
          expect(
            (yield* boxes.action("contexts", { op: "contexts.get", id: "analysis" })).executionId,
          ).toBe("created-dependency");
          const next = yield* boxes.action("contexts", {
            op: "typescript.evaluate",
            id: "second",
            expression:
              "({value:globalThis.bump(),module:await globalThis.dynamicNext()} as {value:number;module:number})",
            contextId: "analysis",
          });
          expect(next.output?.result).toEqual({ value: 42, module: 2 });
          yield* boxes.action("contexts", {
            op: "filesystem.writeFile",
            path: "/tmp/from-file.ts",
            content:
              "globalThis.fileRun=(globalThis.fileRun||0)+1;globalThis.fileURL=import.meta.url;",
            encoding: "utf8",
          });
          for (const id of ["file-one", "file-two"]) {
            expect(
              (yield* boxes.action("contexts", {
                op: "typescript.executeFile",
                contextId: "analysis",
                id,
                path: "/tmp/from-file.ts",
              })).status,
            ).toBe("exited");
          }
          const fromFile = yield* boxes.action("contexts", {
            op: "javascript.evaluate",
            contextId: "analysis",
            id: "file-value",
            expression: "({runs:globalThis.fileRun,url:globalThis.fileURL})",
          });
          expect(fromFile.output?.result).toEqual({ runs: 2, url: "file:///tmp/from-file.ts" });
          const logged = yield* boxes.action("contexts", {
            op: "process.run",
            id: "third",
            language: "javascript",
            source: "export default()=>{globalThis.log('next');return globalThis.bump()}",
            contextId: "analysis",
          });
          expect(logged.output?.result).toBe(43);
          expect(logged.output?.stdout).toBe("next\n");
          const isolated = yield* boxes.action("contexts", {
            op: "javascript.evaluate",
            id: "isolated",
            expression: "typeof globalThis.bump",
          });
          expect(isolated.output?.result).toBe("undefined");
          const reset = yield* boxes.action("contexts", { op: "contexts.reset", id: "analysis" });
          expect(reset.generation).toBe(1);
          const cleared = yield* boxes.action("contexts", {
            op: "javascript.evaluate",
            id: "reset-value",
            expression: "typeof globalThis.bump",
            contextId: "analysis",
          });
          expect(cleared.output?.result).toBe("undefined");
          expect(
            (yield* boxes.action("contexts", { op: "contexts.delete", id: "analysis" })).ok,
          ).toBe(true);
          const missing = yield* boxes
            .action("contexts", { op: "contexts.get", id: "analysis" })
            .pipe(Effect.result);
          if (missing._tag !== "Failure" || missing.failure._tag !== "BoxesError")
            return yield* Effect.die("Deleted context remained visible");
          expect(missing.failure.status).toBe(404);
          const recreated = yield* boxes.action("contexts", {
            op: "contexts.create",
            id: "analysis",
          });
          expect(recreated.generation).toBe(3);
          const fresh = yield* boxes.action("contexts", {
            op: "javascript.evaluate",
            id: "new-lifetime",
            expression: "typeof globalThis.bump",
            contextId: "analysis",
          });
          expect(fresh.output?.result).toBe("undefined");
          yield* boxes.action("contexts", { op: "contexts.create", id: "beta" });
          const page = yield* boxes.action("contexts", { op: "contexts.list", limit: 1 });
          expect(page.contexts.map((context) => context.id)).toEqual(["analysis"]);
          if (page.cursor === null) return yield* Effect.die("Missing native context cursor");
          const tail = yield* boxes.action("contexts", {
            op: "contexts.list",
            limit: 1,
            cursor: page.cursor,
          });
          expect(tail.contexts.map((context) => context.id)).toEqual(["beta"]);
          expect(tail.cursor).toBeNull();
          yield* boxes.action("contexts", { op: "vm.dispose" });
          const collected = [];
          for (const attempt of [0, 1, 2, 3, 4, 5]) {
            const progress = yield* boxes.action("contexts", { op: "vm.reclaim", limit: 1000 });
            collected.push(progress);
            if (progress.status === "complete") break;
            expect(attempt).toBeLessThan(5);
          }
          expect(collected.at(-1)?.status).toBe("complete");
          const objects = yield* Effect.promise(() => second.worker.objects);
          expect(
            (yield* Effect.promise(() => objects.list({ prefix: "sandboxes/contexts/contexts/" })))
              .objects,
          ).toHaveLength(0);
          expect(
            (yield* Effect.promise(() =>
              objects.list({ prefix: "sandboxes/contexts/checkpoint-pages/" }),
            )).objects,
          ).toHaveLength(0);
        }),
      ).pipe(
        Effect.provide(FetchHttpClient.layer),
        Effect.provideService(FetchHttpClient.RequestInit, { keepalive: false }),
      ),
    ),
  30000,
);

test(
  "preflight failure preserves context state while interrupted execution requires reset",
  () =>
    Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const directory = yield* Effect.acquireRelease(
            Effect.promise(() => mkdtemp(join(tmpdir(), "boxes-context-failure-"))),
            (path) => Effect.promise(() => rm(path, { recursive: true, force: true })),
          );
          const connection = yield* connect(directory);
          yield* connection.client.create({ id: "failures", policy });
          const grant = yield* connection.client.mintCapability("failures", {
            permissions: ["read", "write", "execute", "manage"],
            expiresInSeconds: 3600,
          });
          const boxes = yield* make({ url: connection.url, token: Redacted.make(grant.token) });
          yield* boxes.action("failures", { op: "contexts.create", id: "state" });
          yield* boxes.action("failures", {
            op: "javascript.execute",
            id: "seed",
            source: "globalThis.value=41;",
            contextId: "state",
          });
          const invalid = yield* boxes
            .action("failures", {
              op: "javascript.execute",
              id: "invalid",
              source: "export default (;",
              contextId: "state",
            })
            .pipe(Effect.result);
          if (invalid._tag !== "Failure" || invalid.failure._tag !== "BoxesError")
            return yield* Effect.die("Invalid source was admitted");
          expect(invalid.failure.status).toBe(422);
          const retained = yield* boxes.action("failures", {
            op: "javascript.evaluate",
            id: "retained",
            expression: "globalThis.value",
            contextId: "state",
          });
          expect(retained.output?.result).toBe(41);
          const duplicate = yield* boxes
            .action("failures", {
              op: "javascript.evaluate",
              id: "retained",
              expression: "99",
              contextId: "state",
            })
            .pipe(Effect.result);
          if (duplicate._tag !== "Failure" || duplicate.failure._tag !== "BoxesError")
            return yield* Effect.die("Duplicate execution was admitted");
          expect(duplicate.failure.error).toBe("EEXIST");
          expect((yield* boxes.action("failures", { op: "contexts.get", id: "state" })).state).toBe(
            "idle",
          );
          const failed = yield* boxes.action("failures", {
            op: "javascript.execute",
            id: "loop",
            source: "globalThis.value=99;while(true){}",
            contextId: "state",
          });
          expect(failed.status).toBe("failed");
          expect((yield* boxes.action("failures", { op: "contexts.get", id: "state" })).state).toBe(
            "failed",
          );
          const denied = yield* boxes
            .action("failures", {
              op: "javascript.evaluate",
              id: "blocked",
              expression: "globalThis.value",
              contextId: "state",
            })
            .pipe(Effect.result);
          if (denied._tag !== "Failure" || denied.failure._tag !== "BoxesError")
            return yield* Effect.die("Failed context replayed");
          expect(denied.failure.error).toBe("CONTEXT_FAILED");
          yield* boxes.action("failures", { op: "contexts.reset", id: "state" });
          const fresh = yield* boxes.action("failures", {
            op: "javascript.evaluate",
            id: "after-reset",
            expression: "typeof globalThis.value",
            contextId: "state",
          });
          expect(fresh.output?.result).toBe("undefined");
          const noRead = yield* connection.client.mintCapability("failures", {
            permissions: ["execute"],
            expiresInSeconds: 3600,
          });
          const restricted = yield* make({
            url: connection.url,
            token: Redacted.make(noRead.token),
          });
          const forbidden = yield* restricted
            .action("failures", {
              op: "javascript.evaluate",
              id: "no-read",
              expression: "1",
              contextId: "state",
            })
            .pipe(Effect.result);
          if (forbidden._tag !== "Failure" || forbidden.failure._tag !== "BoxesError")
            return yield* Effect.die("Context state escaped read permission");
          expect(forbidden.failure.status).toBe(403);
          for (const action of [
            {
              op: "process.spawn",
              execution: {
                op: "javascript.evaluate",
                id: "queued-context",
                contextId: "state",
                expression: "1",
              },
            },
            {
              op: "cron.schedule",
              id: "scheduled-context",
              schedule: "* * * * *",
              overlap: "skip",
              execution: {
                op: "javascript.evaluate",
                id: "scheduled-run",
                contextId: "state",
                expression: "1",
              },
            },
          ] as const) {
            const rejected = yield* boxes.action("failures", action).pipe(Effect.result);
            if (rejected._tag !== "Failure" || rejected.failure._tag !== "BoxesError")
              return yield* Effect.die("Unsupported detached context was admitted");
            expect(rejected.failure.status).toBe(501);
          }
          expect(
            (yield* boxes.action("failures", {
              op: "process.list",
              limit: 50,
              cursor: null,
            })).items.some((process) => process.id === "queued-context"),
          ).toBe(false);
          expect(
            (yield* boxes.action("failures", { op: "cron.list", limit: 100 })).jobs.some(
              (job) => job.id === "scheduled-context",
            ),
          ).toBe(false);
        }),
      ).pipe(
        Effect.provide(FetchHttpClient.layer),
        Effect.provideService(FetchHttpClient.RequestInit, { keepalive: false }),
      ),
    ),
  30000,
);

const bindingContext = Effect.fn("contextTest.binding")(function* (
  directory: string,
  phase: "create" | "read" | "concurrent" | "timeout",
  id: string,
) {
  return yield* Effect.scoped(
    Effect.gen(function* () {
      const worker = yield* Effect.acquireRelease(
        Effect.sync(() => runtime(directory, { controlled: false, binding: true })),
        (worker) => Effect.promise(() => worker.dispose()),
      );
      const url = yield* Effect.promise(() => worker.binding());
      url.searchParams.set("contexts", phase);
      const response = yield* Effect.promise(() =>
        fetch(url, { method: "POST", body: Schema.encodeSync(Schema.fromJsonString(Id))(id) }),
      );
      expect(response.status).toBe(200);
      return yield* Schema.decodeUnknownEffect(Schema.fromJsonString(ContextBindingProof))(
        yield* Effect.promise(() => response.text()),
      );
    }),
  );
});

test(
  "native Agent binding restores context functions in a replacement Worker using only current callback authority",
  () =>
    Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const directory = yield* Effect.acquireRelease(
            Effect.promise(() => mkdtemp(join(tmpdir(), "boxes-context-binding-"))),
            (path) => Effect.promise(() => rm(path, { recursive: true, force: true })),
          );
          const first = yield* bindingContext(directory, "create", "binding-context");
          expect(first.records[0]?.output?.result).toBe(11);
          expect(first.calls).toBe(1);
          const next = yield* bindingContext(directory, "read", "binding-context");
          expect(next.records.map((record) => record.output?.result)).toEqual([42, "FORBIDDEN"]);
          expect(next.calls).toBe(1);
          expect(next.context.state).toBe("idle");
        }),
      ),
    ),
  15000,
);

test(
  "native Agent context excludes concurrent execution, reset and delete while a callback is pending",
  () =>
    Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const directory = yield* Effect.acquireRelease(
            Effect.promise(() => mkdtemp(join(tmpdir(), "boxes-context-busy-"))),
            (path) => Effect.promise(() => rm(path, { recursive: true, force: true })),
          );
          const result = yield* bindingContext(directory, "concurrent", "busy-context");
          expect(result.errors).toEqual(["CONTEXT_BUSY", "CONTEXT_BUSY", "CONTEXT_BUSY"]);
          expect(result.records[0]?.output?.result).toBe("released");
          expect(result.context.state).toBe("idle");
          expect(result.calls).toBe(1);
        }),
      ),
    ),
  15000,
);

test(
  "native Agent timeout fails the retained context without replaying an accepted callback",
  () =>
    Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const directory = yield* Effect.acquireRelease(
            Effect.promise(() => mkdtemp(join(tmpdir(), "boxes-context-timeout-"))),
            (path) => Effect.promise(() => rm(path, { recursive: true, force: true })),
          );
          const result = yield* bindingContext(directory, "timeout", "timeout-context");
          expect(result.records[0]?.status).toBe("failed");
          expect(result.context.state).toBe("failed");
          expect(result.calls).toBe(1);
        }),
      ),
    ),
  15000,
);

test(
  "R2 context claims avoid ABA at a frozen native clock and reject delayed cleanup",
  () =>
    Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const directory = yield* Effect.acquireRelease(
            Effect.promise(() => mkdtemp(join(tmpdir(), "boxes-context-epochs-"))),
            (path) => Effect.promise(() => rm(path, { recursive: true, force: true })),
          );
          const connection = yield* connect(directory);
          yield* connection.client.create({ id: "epochs", policy });
          const grant = yield* connection.client.mintCapability("epochs", {
            permissions: ["read", "execute"],
            expiresInSeconds: 3600,
          });
          const boxes = yield* make({ url: connection.url, token: Redacted.make(grant.token) });
          const context = yield* boxes.action("epochs", { op: "contexts.create", id: "state" });
          const control = yield* Effect.promise(() => connection.worker.control);
          const proof = yield* Schema.decodeUnknownEffect(ContextClaimProof)(
            yield* Effect.promise(() =>
              control.contextClaims("epochs", grant.token, "state", context.createdAt),
            ),
          );
          expect(new Set(proof.claims).size).toBe(2);
          expect(new Set(proof.epochs).size).toBe(2);
          expect(proof.sameIdleEtag).toBe(true);
          expect(proof.staleRejected).toBe(true);
          expect(proof.heldState).toBe("running");
          expect((yield* boxes.action("epochs", { op: "contexts.get", id: "state" })).state).toBe(
            "idle",
          );
        }),
      ).pipe(
        Effect.provide(FetchHttpClient.layer),
        Effect.provideService(FetchHttpClient.RequestInit, { keepalive: false }),
      ),
    ),
  10000,
);

test(
  "public Python contexts retain closures, fence language/authority and require reset after interruption",
  () =>
    Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const directory = yield* Effect.acquireRelease(
            Effect.promise(() => mkdtemp(join(tmpdir(), "boxes-python-api-"))),
            (path) => Effect.promise(() => rm(path, { recursive: true, force: true })),
          );
          const token = yield* Effect.scoped(
            Effect.gen(function* () {
              const first = yield* connect(directory);
              yield* first.client.create({ id: "python-api", policy });
              const grant = yield* first.client.mintCapability("python-api", {
                permissions: ["read", "write", "execute", "manage"],
                expiresInSeconds: 600,
              });
              const client = yield* make({ url: first.url, token: Redacted.make(grant.token) });
              expect(
                (yield* client.action("python-api", {
                  op: "contexts.create",
                  id: "state",
                  language: "python",
                })).language,
              ).toBe("python");
              const seeded = yield* client.action("python-api", {
                op: "python.execute",
                id: "seed",
                contextId: "state",
                filePath: "/seed.py",
                env: { MODE: "first", OLD: "gone" },
                source:
                  "import os\ncached_env=os.environ\ndef factory():\n n=40\n def next():\n  nonlocal n\n  n+=1\n  return n\n return next\nnext_value=factory()\nnext_value()",
              });
              expect(seeded.output?.result).toBe(41);
              yield* client.action("python-api", {
                op: "filesystem.writeFile",
                path: "/next.py",
                content: "next_value()",
                encoding: "utf8",
              });
              return grant.token;
            }),
          );
          const second = yield* connect(directory, token);
          const client = second.client;
          const resumed = yield* client.action("python-api", {
            op: "python.evaluate",
            id: "resume",
            contextId: "state",
            env: { MODE: "second" },
            expression: "[next_value(),cached_env.get('MODE'),cached_env.get('OLD')]",
          });
          expect(resumed.output?.result).toEqual([42, "second", null]);
          expect(
            (yield* client.action("python-api", {
              op: "process.run",
              id: "inline",
              contextId: "state",
              language: "python",
              source: "next_value()",
            })).output?.result,
          ).toBe(43);
          expect(
            (yield* client.action("python-api", {
              op: "python.executeFile",
              id: "file",
              contextId: "state",
              path: "/next.py",
            })).output?.result,
          ).toBe(44);
          const duplicate = yield* client
            .action("python-api", {
              op: "python.evaluate",
              id: "file",
              contextId: "state",
              expression: "next_value()",
            })
            .pipe(Effect.result);
          if (duplicate._tag !== "Failure" || duplicate.failure._tag !== "BoxesError")
            return yield* Effect.die("Duplicate Python execution was admitted");
          expect(duplicate.failure.error).toBe("EEXIST");
          const mismatch = yield* client
            .action("python-api", {
              op: "javascript.evaluate",
              id: "wrong-language",
              contextId: "state",
              expression: "42",
            })
            .pipe(Effect.result);
          if (mismatch._tag !== "Failure" || mismatch.failure._tag !== "BoxesError")
            return yield* Effect.die("Wrong context language was admitted");
          expect(mismatch.failure.error).toBe("CONTEXT_LANGUAGE_MISMATCH");
          expect(
            (yield* client.action("python-api", {
              op: "python.evaluate",
              id: "ordinary",
              expression: "'next_value' in globals()",
            })).output?.result,
          ).toBe(false);
          const invalid = yield* client.action("python-api", {
            op: "python.execute",
            id: "syntax",
            contextId: "state",
            source: "def :",
          });
          expect(invalid.output?.exitCode).toBe(1);
          expect(
            (yield* client.action("python-api", {
              op: "python.evaluate",
              id: "after-syntax",
              contextId: "state",
              expression: "next_value()",
            })).output?.result,
          ).toBe(45);
          const administrator = yield* make({
            url: second.url,
            token: Redacted.make("cirro-local-test-credential"),
          });
          const executeGrant = yield* administrator.mintCapability("python-api", {
            permissions: ["execute"],
            expiresInSeconds: 60,
          });
          const executeOnly = yield* make({
            url: second.url,
            token: Redacted.make(executeGrant.token),
          });
          const unauthorized = yield* executeOnly
            .action("python-api", {
              op: "python.evaluate",
              id: "execute-only",
              contextId: "state",
              expression: "next_value()",
            })
            .pipe(Effect.result);
          if (unauthorized._tag !== "Failure" || unauthorized.failure._tag !== "BoxesError")
            return yield* Effect.die("Execute-only authority read retained Python state");
          expect(unauthorized.failure.status).toBe(403);
          const failed = yield* client.action("python-api", {
            op: "python.execute",
            id: "loop",
            contextId: "state",
            source: "while True:\n pass",
          });
          expect(failed.status).toBe("failed");
          expect(
            (yield* client.action("python-api", { op: "contexts.get", id: "state" })).state,
          ).toBe("failed");
          const blocked = yield* client
            .action("python-api", {
              op: "python.evaluate",
              id: "after-trap",
              contextId: "state",
              expression: "next_value()",
            })
            .pipe(Effect.result);
          if (blocked._tag !== "Failure" || blocked.failure._tag !== "BoxesError")
            return yield* Effect.die("Failed Python context was replayed");
          expect(blocked.failure.error).toBe("CONTEXT_FAILED");
          const reset = yield* client.action("python-api", { op: "contexts.reset", id: "state" });
          expect([reset.language, reset.generation]).toEqual(["python", 1]);
          expect(
            (yield* client.action("python-api", {
              op: "python.evaluate",
              id: "fresh",
              contextId: "state",
              expression: "'next_value' in globals()",
            })).output?.result,
          ).toBe(false);
          yield* client.action("python-api", { op: "contexts.delete", id: "state" });
          expect(
            (yield* client.action("python-api", {
              op: "contexts.create",
              id: "state",
              language: "python",
            })).generation,
          ).toBe(3);
          yield* client.action("python-api", { op: "vm.dispose" });
          const reclaimed = yield* client
            .action("python-api", { op: "vm.reclaim", limit: 1000 })
            .pipe(Effect.repeat({ until: (result) => result.status === "complete", times: 5 }));
          expect(reclaimed.status).toBe("complete");
          const objects = yield* Effect.promise(() => second.worker.objects);
          const remaining = yield* Effect.promise(() =>
            objects.list({ prefix: "sandboxes/python-api/" }),
          );
          expect(remaining.objects.map((object) => object.key)).toEqual([
            "sandboxes/python-api/head.json",
          ]);
        }),
      ).pipe(Effect.provide(FetchHttpClient.layer)),
    ),
  60_000,
);

test(
  "native Agent binding resumes Python with renewed grants in a replacement Worker",
  () =>
    Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const directory = yield* Effect.acquireRelease(
            Effect.promise(() => mkdtemp(join(tmpdir(), "boxes-python-binding-"))),
            (path) => Effect.promise(() => rm(path, { recursive: true, force: true })),
          );
          const proofs = yield* Effect.forEach(["create", "read"] as const, (phase) =>
            Effect.scoped(
              Effect.gen(function* () {
                const worker = yield* Effect.acquireRelease(
                  Effect.sync(() => runtime(directory, { binding: true, controlled: false })),
                  (worker) => Effect.promise(() => worker.dispose()),
                );
                const url = yield* Effect.promise(() => worker.binding());
                url.searchParams.set("python_contexts", phase);
                const response = yield* Effect.promise(() =>
                  fetch(url, {
                    method: "POST",
                    body: Schema.encodeSync(Schema.fromJsonString(Id))("python-binding"),
                  }),
                );
                if (response.status !== 200)
                  return yield* Effect.die({
                    status: response.status,
                    body: yield* Effect.promise(() => response.text()),
                  });
                return yield* Schema.decodeUnknownEffect(
                  Schema.fromJsonString(ContextBindingProof),
                )(yield* Effect.promise(() => response.text()));
              }),
            ),
          );
          expect(proofs[0]?.records[0]?.output?.result).toBe(41);
          expect(proofs[1]?.context.language).toBe("python");
          expect(proofs[1]?.records[0]?.output?.result).toEqual([42, "current", "/seed.py"]);
          expect(proofs[1]?.records[1]?.output?.result).toBe("FORBIDDEN");
        }),
      ),
    ),
  60_000,
);
