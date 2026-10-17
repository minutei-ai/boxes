import { Clock, Effect, Schema } from "effect";
import { createBindings } from "../dist/python/bindings";
import { Digest, RunResult } from "../src/contracts";

const Completed = Schema.Struct({
  kind: Schema.Literal("done"),
  output: Schema.fromJsonString(RunResult),
});
const Variant = Schema.Literals(["reference", "candidate"]);
const Sample = Schema.Struct({
  phase: Schema.Int,
  variant: Variant,
  workload: Schema.String,
  index: Schema.Int,
  elapsedMs: Schema.Number,
  fuel: Schema.Int,
  memoryBytes: Schema.Int,
});
const Report = Schema.Struct({
  runtime: Schema.String,
  scope: Schema.String,
  variants: Schema.Array(Schema.Struct({ label: Variant, sha256: Digest, bytes: Schema.Int })),
  workloads: Schema.Array(Schema.Struct({ id: Schema.String, sourceSha256: Digest })),
  phases: Schema.Array(Variant),
  warmups: Schema.Int,
  samples: Schema.Array(Sample),
});
const arguments_ = Schema.decodeUnknownSync(
  Schema.Tuple([Schema.String, Schema.String, Schema.String]),
)(Bun.argv.slice(2));
const workloads = [
  { id: "evaluate", evaluate: true, source: "sum(n*n for n in range(100))", expected: 328350 },
  {
    id: "definitions",
    evaluate: false,
    source:
      Array.from({ length: 64 }, (_, index) => `def answer${index}(value):\n return value+1`).join(
        "\n",
      ) + "\nanswer63(41)",
    expected: 42,
  },
] as const;
const phases = [
  "reference",
  "candidate",
  "candidate",
  "reference",
  "candidate",
  "reference",
  "reference",
  "candidate",
] as const;
const budget = 100_000_000n;
const report = await Effect.runPromise(
  Effect.scoped(
    Effect.gen(function* () {
      const variants = yield* Effect.forEach(["reference", "candidate"] as const, (label, index) =>
        Effect.gen(function* () {
          const bytes = yield* Effect.promise(() => Bun.file(arguments_[index]).arrayBuffer());
          const module = new WebAssembly.Module(bytes);
          return {
            label,
            module,
            bytes: bytes.byteLength,
            sha256: new Bun.CryptoHasher("sha256").update(bytes).digest("hex"),
          };
        }),
      );
      const baseline = variants[0];
      for (const variant of variants) {
        if (
          JSON.stringify(WebAssembly.Module.imports(baseline.module)) !==
            JSON.stringify(WebAssembly.Module.imports(variant.module)) ||
          JSON.stringify(WebAssembly.Module.exports(baseline.module)) !==
            JSON.stringify(WebAssembly.Module.exports(variant.module))
        )
          return yield* Effect.die(
            "Native Python ABI differs; use matching adapters before benchmarking",
          );
      }
      const samples = yield* Effect.forEach(phases, (label, phase) =>
        Effect.scoped(
          Effect.gen(function* () {
            const variant = variants.find((variant) => variant.label === label);
            if (variant === undefined) return yield* Effect.die("Missing benchmark variant");
            const bindings = createBindings();
            const native = bindings.initSync({ module: variant.module });
            native.__cirro_limits(budget, 1024);
            const guest = yield* Effect.acquireRelease(
              Effect.sync(() => new bindings.PythonGuest("0", "/warm.py", true, 1_048_576, "{}")),
              (guest) => Effect.sync(() => guest.free()),
            );
            Schema.decodeUnknownSync(Schema.fromJsonString(Completed))(guest.step());
            const collected: (typeof Sample.Type)[] = [];
            for (const workload of workloads) {
              for (const index of Array.from({ length: 18 }, (_, index) => index - 3)) {
                native.__cirro_limits(budget, 1024);
                const started = yield* Clock.currentTimeNanos;
                const result = yield* Effect.sync(() => {
                  guest.begin(workload.source, "/benchmark.py", workload.evaluate, "{}");
                  return Schema.decodeUnknownSync(Schema.fromJsonString(Completed))(guest.step());
                });
                const ended = yield* Clock.currentTimeNanos;
                if (
                  result.output.exitCode !== 0 ||
                  result.output.stderr !== "" ||
                  result.output.result !== workload.expected
                )
                  return yield* Effect.die({ phase, workload: workload.id, index, result });
                if (index >= 0)
                  collected.push({
                    phase,
                    variant: label,
                    workload: workload.id,
                    index,
                    elapsedMs: Number(ended - started) / 1_000_000,
                    fuel: Number(
                      budget - Schema.decodeUnknownSync(Schema.BigInt)(native.__cirro_fuel.value),
                    ),
                    memoryBytes: native.memory.buffer.byteLength,
                  });
              }
            }
            return collected;
          }),
        ),
      );
      return {
        runtime: `Bun ${Bun.version}`,
        scope:
          "Native RustPython Wasm begin/step in Bun; quiescent retained interpreter per phase. Excludes Worker/R2, construction, cold startup and billing. Fuel includes begin and step. All outputs validated; phases alternate ABBA then BAAB.",
        variants: variants.map(({ label, sha256, bytes }) => ({ label, sha256, bytes })),
        workloads: workloads.map(({ id, source }) => ({
          id,
          sourceSha256: new Bun.CryptoHasher("sha256").update(source).digest("hex"),
        })),
        phases,
        warmups: 3,
        samples: samples.flat(),
      };
    }),
  ),
);
await Bun.write(arguments_[2], Schema.encodeSync(Schema.fromJsonString(Report))(report));
console.log(
  JSON.stringify({
    output: arguments_[2],
    samples: report.samples.length,
    variants: report.variants,
  }),
);
