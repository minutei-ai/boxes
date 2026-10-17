import { Clock, Effect, Schema } from "effect";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runtime } from "./worker-test";
import { pythonCheckpointPrograms } from "../tests/fixtures/python-checkpoint-inputs";
import {
  PythonCheckpointProof,
  PythonCheckpointRequest,
} from "../tests/fixtures/python-checkpoint-contract";

const arguments_ = Schema.decodeUnknownSync(Schema.Tuple([Schema.String]))(Bun.argv.slice(2));
const Measurement = Schema.Struct({
  phase: Schema.Int,
  elapsedMs: Schema.Number,
  proof: PythonCheckpointProof,
});
const Report = Schema.Struct({
  measuredAt: Schema.Int,
  runtime: Schema.String,
  scope: Schema.String,
  workloadSha256: Schema.String,
  pythonWasmSha256: Schema.String,
  measurements: Schema.Array(Measurement),
});
const report = await Effect.runPromise(
  Effect.scoped(
    Effect.gen(function* () {
      const directory = yield* Effect.acquireRelease(
        Effect.promise(() => mkdtemp(join(tmpdir(), "boxes-python-memory-"))),
        (path) => Effect.promise(() => rm(path, { recursive: true, force: true })),
      );
      const measurements: (typeof Measurement.Type)[] = [];
      for (const [phase, program] of pythonCheckpointPrograms.entries()) {
        yield* Effect.scoped(
          Effect.gen(function* () {
            const worker = yield* Effect.acquireRelease(
              Effect.sync(() => runtime(directory, { artifact: "python-checkpoint-worker" })),
              (worker) => Effect.promise(() => worker.dispose()),
            );
            const url = yield* Effect.promise(() => worker.ready);
            const prior = measurements.at(-1);
            const started = yield* Clock.currentTimeNanos;
            const response = yield* Effect.tryPromise(() =>
              fetch(url, {
                method: "POST",
                body: Schema.encodeSync(Schema.fromJsonString(PythonCheckpointRequest))({
                  hash: prior?.proof.hash ?? null,
                  program,
                  reply: 2,
                }),
              }),
            );
            if (!response.ok)
              return yield* Effect.die({
                status: response.status,
                body: yield* Effect.promise(() => response.text()),
              });
            const proof = yield* Schema.decodeUnknownEffect(
              Schema.fromJsonString(PythonCheckpointProof),
            )(yield* Effect.promise(() => response.text()));
            const finished = yield* Clock.currentTimeNanos;
            if (
              proof.output.exitCode !== 0 ||
              proof.reads !== (prior?.proof.packs ?? 0) ||
              !Schema.is(Schema.Array(Schema.Json))(proof.output.result)
            )
              return yield* Effect.die(proof);
            measurements.push({ phase, elapsedMs: Number(finished - started) / 1_000_000, proof });
          }),
        );
      }
      const source = yield* Effect.promise(() =>
        Bun.file("tests/fixtures/python-checkpoint-inputs.ts").arrayBuffer(),
      );
      const wasm = yield* Effect.promise(() =>
        Bun.file("dist/python/cirro_python_bg.wasm").arrayBuffer(),
      );
      return {
        measuredAt: yield* Clock.currentTimeMillis,
        runtime: `Bun ${Bun.version}; native Alchemy workerd and local R2`,
        scope:
          "Three native Python executions with each prior Worker closed before the next starts. Counts forward real R2 pack gets; elapsed time includes the request and checkpoint publication, excludes Worker startup, and is not a production latency distribution.",
        workloadSha256: new Bun.CryptoHasher("sha256").update(source).digest("hex"),
        pythonWasmSha256: new Bun.CryptoHasher("sha256").update(wasm).digest("hex"),
        measurements,
      };
    }),
  ),
);
await Bun.write(arguments_[0], Schema.encodeSync(Schema.fromJsonString(Report))(report));
console.log(
  JSON.stringify({
    output: arguments_[0],
    measurements: report.measurements.map(({ phase, elapsedMs, proof }) => ({
      phase,
      elapsedMs,
      memoryBytes: proof.memoryBytes,
      uniquePages: proof.uniquePages,
      packs: proof.packs,
      reads: proof.reads,
      puts: proof.puts,
    })),
  }),
);
