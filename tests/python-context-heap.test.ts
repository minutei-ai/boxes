import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Schema } from "effect";
import { Digest, PythonProgram } from "../src/contracts";
import { runtime } from "../tooling/worker-test";
import {
  PythonCheckpointProof,
  PythonCheckpointRequest,
} from "./fixtures/python-checkpoint-contract";

test(
  "R2 retains native Python closures and resets environment/output through closed Workers",
  () =>
    Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const directory = yield* Effect.acquireRelease(
            Effect.promise(() => mkdtemp(join(tmpdir(), "boxes-python-heap-"))),
            (path) => Effect.promise(() => rm(path, { recursive: true, force: true })),
          );
          const programs = [
            PythonProgram.make({
              language: "python",
              env: { MODE: "first", OLD: "removed" },
              filePath: "/first.py",
              mode: "execute",
              source:
                "import os, sys\ncached_env = os.environ\nwriter = sys.stdout.write\ndef factory():\n n = 40\n def next():\n  nonlocal n\n  n += 1\n  return n\n return next\nnext_value = factory()\nreply = await tools.call({'op':'host.call','name':'echo','input':2})\nprint('first')\n[next_value(), reply, os.getenv('MODE')]",
            }),
            PythonProgram.make({
              language: "python",
              env: { MODE: "second" },
              filePath: "/second.py",
              mode: "execute",
              source:
                "writer('second\\n')\n[next_value(), cached_env.get('MODE'), cached_env.get('OLD'), next_value.__code__.co_filename]",
            }),
            PythonProgram.make({
              language: "python",
              env: { MODE: "third" },
              filePath: "/third.py",
              mode: "evaluate",
              source: "next_value()",
            }),
          ];
          yield* Effect.reduce(
            programs,
            () => Schema.decodeUnknownSync(Schema.NullOr(Digest))(null),
            (hash, program, index) =>
              Effect.scoped(
                Effect.gen(function* () {
                  const worker = yield* Effect.acquireRelease(
                    Effect.sync(() => runtime(directory, { artifact: "python-checkpoint-worker" })),
                    (worker) => Effect.promise(() => worker.dispose()),
                  );
                  const response = yield* Effect.promise(async () =>
                    fetch(await worker.ready, {
                      method: "POST",
                      body: Schema.encodeSync(Schema.fromJsonString(PythonCheckpointRequest))({
                        hash,
                        program,
                        reply: 2,
                      }),
                    }),
                  );
                  if (response.status !== 200)
                    return yield* Effect.die({
                      status: response.status,
                      body: yield* Effect.promise(() => response.text()),
                    });
                  const proof = yield* Schema.decodeUnknownEffect(
                    Schema.fromJsonString(PythonCheckpointProof),
                  )(yield* Effect.promise(() => response.text()));
                  expect(proof.output.exitCode).toBe(0);
                  expect(proof.output.stderr).toBe("");
                  expect(proof.pageWrites).toBeGreaterThan(0);
                  if (index === 0) {
                    expect(proof.output.result).toEqual([41, 2, "first"]);
                    expect(proof.output.stdout).toBe("first\n");
                    expect(proof.nonquiescentDenied).toBe(true);
                    expect(proof.duplicateHandleDenied).toBe(false);
                  } else {
                    expect(proof.duplicateHandleDenied).toBe(true);
                    if (index === 1) {
                      expect(proof.output.result).toEqual([42, "second", null, "/first.py"]);
                      expect(proof.output.stdout).toBe("second\n");
                    } else {
                      expect(proof.output.result).toBe(43);
                      expect(proof.output.stdout).toBe("");
                    }
                  }
                  return proof.hash;
                }),
              ),
          );
        }),
      ),
    ),
  60_000,
);
