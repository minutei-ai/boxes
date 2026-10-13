import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Schema } from "effect";
import { Status, TokenResponse, RunRecord } from "../src/contracts";
import { runtime } from "./runtime";

const directory = await mkdtemp(join(tmpdir(), "cirro-benchmark-"));
const mf = runtime(directory);
const origin = await mf.ready;
const post = (path: string, token: string, body: unknown) =>
  fetch(new URL(path, origin), {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
const created = await post("/v1/sandboxes", "cirro-local-test-credential", {
  id: "bench",
  policy: {
    interruptBudget: 1000,
    memoryBytes: 8_388_608,
    maxOutputBytes: 1_048_576,
    networkHosts: [],
  },
});
if (created.status !== 201) process.exit(1);
const minted = await post("/v1/sandboxes/bench/capabilities", "cirro-local-test-credential", {
  permissions: ["read", "write", "execute"],
  expiresInSeconds: 3600,
});
const token = Schema.decodeUnknownSync(TokenResponse)(await minted.json()).token;
const call = (body: unknown) => post("/v1/sandboxes/bench/action", token, body);
const sample = async (count: number, operation: (index: number) => Promise<unknown>) => {
  const times: number[] = [];
  for (const index of Array.from({ length: count }, (_, index) => index)) {
    const start = performance.now();
    await operation(index);
    times.push(performance.now() - start);
  }
  const sorted = times.toSorted((a, b) => a - b);
  return {
    count,
    p50Ms: sorted[Math.floor(count * 0.5)],
    p95Ms: sorted[Math.floor(count * 0.95)],
    minMs: sorted[0],
    maxMs: sorted[count - 1],
  };
};
await call({ op: "vm.status" });
const status = await sample(100, async () => {
  const response = await call({ op: "vm.status" });
  Schema.decodeUnknownSync(Status)(await response.json());
});
const content = "x".repeat(262_144);
const writes = await sample(25, async () => {
  const response = await call({
    op: "filesystem.writeFile",
    path: "/tmp/blob",
    content,
    encoding: "utf8",
  });
  if (response.status !== 200) process.exit(1);
  await response.text();
});
const reads = await sample(25, async () => {
  const response = await call({ op: "filesystem.readFile", path: "/tmp/blob" });
  if (response.status !== 200) process.exit(1);
  await response.text();
});
const entries = Array.from({ length: 8 }, (_, index) => ({
  path: `/tmp/batch-${index}`,
  content,
  encoding: "utf8" as const,
}));
const initialized = await call({ op: "filesystem.writeFiles", entries });
if (initialized.status !== 200) process.exit(1);
const beforeSequential = Schema.decodeUnknownSync(Status)(
  await (await call({ op: "vm.status" })).json(),
);
const sequentialEightFiles = await sample(25, async () => {
  for (const entry of entries) {
    const response = await call({ op: "filesystem.writeFile", ...entry });
    if (response.status !== 200) process.exit(1);
    await response.text();
  }
});
const afterSequential = Schema.decodeUnknownSync(Status)(
  await (await call({ op: "vm.status" })).json(),
);
const batchEightFiles = await sample(25, async () => {
  const response = await call({ op: "filesystem.writeFiles", entries });
  if (response.status !== 200) process.exit(1);
  await response.text();
});
const afterBatch = Schema.decodeUnknownSync(Status)(await (await call({ op: "vm.status" })).json());
const bucket = await mf.getR2Bucket("OBJECTS");
const blocks = await bucket.list({ prefix: "sandboxes/bench/blobs/" });
const javascript = await sample(25, async (i) => {
  const response = await call({
    op: "process.run",
    id: `js-${i}`,
    language: "javascript",
    source: "export default () => 6 * 7;",
  });
  const record = Schema.decodeUnknownSync(RunRecord)(await response.json());
  if (record.output?.result !== 42) process.exit(1);
});
const wasiSource = Buffer.from(
  await Bun.file(join(import.meta.dir, "../dist/wasi-test.wasm")).arrayBuffer(),
).toString("base64");
const beforeWasi = Schema.decodeUnknownSync(Status)(await (await call({ op: "vm.status" })).json());
const wasiFileAndSync = await sample(25, async (index) => {
  const response = await call({
    op: "process.run",
    id: `wasi-${index}`,
    language: "wasm",
    source: wasiSource,
  });
  const record = Schema.decodeUnknownSync(RunRecord)(await response.json());
  if (record.output?.exitCode !== 0 || record.output.stdout !== "persistent WASI\n")
    process.exit(1);
});
const afterWasi = Schema.decodeUnknownSync(Status)(await (await call({ op: "vm.status" })).json());
const shell = await sample(25, async (i) => {
  const response = await call({
    op: "process.run",
    id: `sh-${i}`,
    language: "shell",
    source: "echo hello | wc -c",
  });
  const record = Schema.decodeUnknownSync(RunRecord)(await response.json());
  if (record.output?.stdout !== "6\n") process.exit(1);
});
const python = await sample(25, async (index) => {
  const response = await call({
    op: "python.evaluate",
    id: `python-${index}`,
    expression: "sum(n*n for n in range(100))",
  });
  const record = Schema.decodeUnknownSync(RunRecord)(await response.json());
  if (record.output?.exitCode !== 0 || record.output.result !== 328350) process.exit(1);
});
const rangeBytes = Buffer.alloc(8_388_608, 97);
const rangeCreated = await call({
  op: "filesystem.writeFile",
  path: "/tmp/range-benchmark",
  content: rangeBytes.toString("base64"),
  encoding: "base64",
});
if (rangeCreated.status !== 200) process.exit(1);
const fullEightMiB = await sample(25, async () => {
  const response = await call({ op: "filesystem.readFile", path: "/tmp/range-benchmark" });
  if (response.status !== 200) process.exit(1);
  await response.arrayBuffer();
});
const rangeFourKiB = await sample(25, async () => {
  const response = await call({
    op: "filesystem.readFile",
    path: "/tmp/range-benchmark",
    offset: 4_194_304,
    length: 4096,
  });
  if (response.status !== 200) process.exit(1);
  await response.arrayBuffer();
});
const patchFourKiB = await sample(25, async (index) => {
  const response = await call({
    op: "filesystem.writeFile",
    path: "/tmp/range-benchmark",
    offset: 4_194_304,
    content: Buffer.alloc(4096, index).toString("base64"),
    encoding: "base64",
  });
  if (response.status !== 200) process.exit(1);
});
const report = {
  measuredAt: new Date().toISOString(),
  environment: {
    runtime: "local workerd via Miniflare",
    miniflare: "5.20261006.1-alpha",
    production: false,
    platform: process.platform,
    arch: process.arch,
  },
  artifactBytes: {
    javascript: (await stat(join(import.meta.dir, "../dist/worker/index.js"))).size,
    kernelWasm: (await stat(join(import.meta.dir, "../dist/worker/cirro_kernel_bg.wasm"))).size,
    wasiWasm: (await stat(join(import.meta.dir, "../dist/worker/cirro_wasi_bg.wasm"))).size,
    pythonWasm: (await stat(join(import.meta.dir, "../dist/worker/cirro_python_bg.wasm"))).size,
    guestWasm: (await stat(join(import.meta.dir, "../dist/worker/cirro_guest_bg.wasm"))).size,
    compilerWasm: (await stat(join(import.meta.dir, "../dist/worker/cirro_compiler_bg.wasm"))).size,
  },
  measurements: {
    fullEightMiB,
    rangeFourKiB,
    patchFourKiB,
    python,
    sequentialEightFiles,
    batchEightFiles,
    status,
    write256KiB: writes,
    read256KiB: reads,
    isolatedJavascript: javascript,
    wasiFileAndSync,
    shellPipeline: shell,
  },
  wasiPublication: { samples: 25, rootPublications: afterWasi.generation - beforeWasi.generation },
  batchPublication: {
    filesPerSample: 8,
    samples: 25,
    sequentialPublications: afterSequential.generation - beforeSequential.generation,
    batchPublications: afterBatch.generation - afterSequential.generation,
  },
  contentDeduplication: {
    singleFileWrites: 25,
    uniqueBlocks: blocks.objects.length,
    singleFileLogicalBytesWritten: 25 * content.length,
    storedBlockBytes: blocks.objects.reduce((size, block) => size + block.size, 0),
  },
};
await Bun.write(
  join(import.meta.dir, "../docs/evidence/performance-local.json"),
  JSON.stringify(report, null, 2) + "\n",
);
console.log(JSON.stringify(report, null, 2));
await mf.dispose();
await rm(directory, { recursive: true, force: true });
