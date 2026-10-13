import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Schema } from "effect";
import { Status, TokenResponse, RunRecord } from "../src/contracts";
import { runtime } from "./runtime";

const directory = await mkdtemp(join(tmpdir(), "cirro-benchmark-"));
const mf = runtime(directory);
const service = await mf.getWorker("cirro");
const post = (path: string, token: string, body: unknown) =>
  service.fetch(`https://cirro.test${path}`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
const created = await post("/v1/sandboxes", "cirro-local-test-credential", {
  id: "bench",
  policy: { cpuMs: 1000, maxOutputBytes: 1_048_576, networkHosts: [] },
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
const bucket = await mf.getR2Bucket("OBJECTS");
const blocks = await bucket.list({ prefix: "sandboxes/bench/blobs/" });
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
    wasm: (await stat(join(import.meta.dir, "../dist/worker/cirro_kernel_bg.wasm"))).size,
  },
  measurements: {
    status,
    write256KiB: writes,
    read256KiB: reads,
    isolatedJavascript: javascript,
    shellPipeline: shell,
  },
  contentDeduplication: {
    writes: 25,
    uniqueBlocks: blocks.objects.length,
    logicalBytesWritten: 25 * content.length,
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
