import { Schema } from "effect";
import { initSync, Kernel } from "../dist/kernel/cirro_kernel";
import { DirectoryTree, FileStat } from "../src/contracts";

const Measurement = Schema.Struct({
  entries: Schema.Int,
  algorithm: Schema.Literals(["scalar", "bulk"]),
  sample: Schema.Int,
  elapsedMs: Schema.Number,
  metadataSha256: Schema.String,
  wasmLinearMemoryBytes: Schema.Int,
});
const Report = Schema.Struct({
  runtime: Schema.String,
  kernelSha256: Schema.String,
  measurements: Schema.Array(Measurement),
});
const bytes = await Bun.file(
  new URL("../dist/kernel/cirro_kernel_bg.wasm", import.meta.url),
).arrayBuffer();
const wasm = initSync({ module: new WebAssembly.Module(bytes) });
const measurements: (typeof Measurement.Type)[] = [];
for (const count of [1024, 4096, 16384]) {
  const kernel = new Kernel();
  for (const index of Array.from({ length: count - kernel.node_count() }, (_, index) => index))
    kernel.write(`/tmp/f${index.toString().padStart(5, "0")}`, 0n, "[]");
  for (const sample of Array.from({ length: 5 }, (_, index) => index)) {
    for (const algorithm of ["scalar", "bulk"] as const) {
      const start = performance.now();
      const metadata = (() => {
        if (algorithm === "bulk")
          return Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Array(FileStat)))(
            kernel.snapshot_metadata(),
          );
        const tree = Schema.decodeUnknownSync(Schema.fromJsonString(DirectoryTree))(
          kernel.readdir_recursive("/", 64, "[]"),
        );
        return ["/", ...tree.map((entry) => entry.path)].map((path) =>
          Schema.decodeUnknownSync(Schema.fromJsonString(FileStat))(kernel.stat(path, false)),
        );
      })();
      const elapsedMs = performance.now() - start;
      const encoded = Schema.encodeSync(Schema.fromJsonString(Schema.Array(FileStat)))(metadata);
      const metadataSha256 = Buffer.from(
        await crypto.subtle.digest("SHA-256", Buffer.from(encoded)),
      ).toString("hex");
      measurements.push({
        entries: count,
        algorithm,
        sample,
        elapsedMs,
        metadataSha256,
        wasmLinearMemoryBytes: wasm.memory.buffer.byteLength,
      });
    }
  }
  kernel.free();
}
for (const count of [1024, 4096, 16384]) {
  const digests = new Set(
    measurements
      .filter((sample) => sample.entries === count)
      .map((sample) => sample.metadataSha256),
  );
  if (digests.size !== 1) process.exit(1);
}
console.log(
  Schema.encodeSync(Schema.fromJsonString(Report))({
    runtime:
      "Bun-hosted native kernel Wasm; alternating scalar and bulk metadata collection with Effect Schema decoding; empty unique-inode files; five samples per algorithm; not production or full snapshot latency",
    kernelSha256: Buffer.from(await crypto.subtle.digest("SHA-256", bytes)).toString("hex"),
    measurements,
  }),
);
