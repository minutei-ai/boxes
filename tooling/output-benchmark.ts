import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Schema } from "effect";
import { ProcessOutputPage, RunRecord, TokenResponse } from "../src/contracts";
import { runtime } from "./worker-test";

const directory = await mkdtemp(join(tmpdir(), "cirro-output-bench-"));
const mf = runtime(directory, { consume: true, controlled: false });
const origin = await mf.ready;
const post = (path: string, token: string, body: unknown) =>
  fetch(new URL(path, origin), {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
const created = await post("/v1/sandboxes", "cirro-local-test-credential", {
  id: "output-bench",
  policy: {
    networkHosts: [],
    interruptBudget: 1000,
    memoryBytes: 8_388_608,
    maxOutputBytes: 1_048_576,
  },
});
if (created.status !== 201) process.exit(1);
const minted = await post(
  "/v1/sandboxes/output-bench/capabilities",
  "cirro-local-test-credential",
  { permissions: ["read", "execute"], expiresInSeconds: 3600 },
);
const token = Schema.decodeUnknownSync(TokenResponse)(await minted.json()).token;
const act = (body: unknown) => post("/v1/sandboxes/output-bench/action", token, body);
const response = await act({
  op: "process.run",
  id: "large",
  language: "javascript",
  source:
    'export default ({console}) => { console.log("😀".repeat(150000)); console.error("retained stderr"); return 42; }',
});
if (response.status !== 200) process.exit(1);
const record = Schema.decodeUnknownSync(RunRecord)(await response.json());
const measurements = await Promise.all(
  [0, 299999, 590000].map(async (after) => {
    const samples: number[] = [];
    for (const index of Array.from({ length: 26 }, (_, index) => index)) {
      const startedAt = performance.now();
      const response = await act({
        op: "process.output.read",
        id: "large",
        after,
        maxBytes: 4096,
        maxEvents: 1,
      });
      if (response.status !== 200) process.exit(1);
      const page = Schema.decodeUnknownSync(ProcessOutputPage)(await response.json());
      const emitted = Buffer.concat(page.events.map((event) => Buffer.from(event.data, "base64")));
      if (!emitted.equals(Buffer.from(record.output?.stdout ?? "").subarray(after, after + 4096)))
        process.exit(1);
      if (index !== 0) samples.push(performance.now() - startedAt);
    }
    const sorted = samples.toSorted((a, b) => a - b);
    return {
      after,
      returnedBytes: 4096,
      samples: samples.length,
      p50Ms: sorted[12],
      p95Ms: sorted[23],
    };
  }),
);
const bucket = await mf.objects;
const receipt = await bucket.head("processes/output-bench/large.json");
const blocks = await bucket.list({ prefix: "sandboxes/output-bench/stdio/" });
const report = {
  measuredAt: new Date().toISOString(),
  runtime: "local workerd via native Alchemy",
  production: false,
  concurrentPageReaders: 3,
  stdoutBytes: Buffer.byteLength(record.output?.stdout ?? ""),
  receiptBytes: receipt?.size,
  immutableBlocks: blocks.objects.length,
  storedBlockBytes: blocks.objects.reduce((sum, block) => sum + block.size, 0),
  measurements,
};
console.log(JSON.stringify(report, null, 2));
await mf.dispose();
await rm(directory, { recursive: true, force: true });
