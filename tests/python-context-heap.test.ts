import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Schema } from "effect";
import { runtime } from "../tooling/worker-test";
import { pythonCheckpointPrograms } from "./fixtures/python-checkpoint-inputs";
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
          yield* Effect.reduce(
            pythonCheckpointPrograms.map((program, index) => {
              if (index === 0)
                return {
                  ...program,
                  source: `from _thread import allocate_lock\nplain_lock=allocate_lock()\nassert plain_lock.acquire(False)\n${program.source}`,
                };
              if (index === 1)
                return {
                  ...program,
                  source: `assert plain_lock.locked()\nassert not plain_lock.acquire(False)\nplain_lock.release()\n${program.source}`,
                };
              return {
                ...program,
                source: `(not plain_lock.locked(), plain_lock.acquire(False), ${program.source})`,
              };
            }),
            () => Schema.decodeUnknownSync(Schema.NullOr(PythonCheckpointProof))(null),
            (prior, program, index) =>
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
                        hash: prior?.hash ?? null,
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
                  expect(proof.puts).toBeGreaterThan(0);
                  expect(proof.reads).toBe(prior?.packs ?? 0);
                  expect(proof.uniquePages * 65536).toBeLessThanOrEqual(proof.memoryBytes);
                  if (index === 0) {
                    expect(proof.output.result).toEqual([41, 2, "first"]);
                    expect(proof.output.stdout).toBe("first\n");
                    expect(proof.nonquiescentDenied).toBe(true);
                    expect(proof.duplicateHandleDenied).toBe(false);
                  } else {
                    expect(proof.duplicateHandleDenied).toBe(true);
                    if (index === 1) {
                      expect(proof.output.result).toEqual([
                        42,
                        "second",
                        null,
                        "/first.py",
                        { value: 42, text: "ação" },
                        ["box", "native"],
                        1,
                        42,
                        2,
                      ]);
                      expect(proof.output.stdout).toBe("second\n");
                    } else {
                      expect(proof.output.result).toEqual([true, true, [43, false]]);
                      expect(proof.output.stdout).toBe("");
                    }
                  }
                  return proof;
                }),
              ),
          );
        }),
      ),
    ),
  60_000,
);
