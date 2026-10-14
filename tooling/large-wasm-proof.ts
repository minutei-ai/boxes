import { Config, Effect, Redacted, Schema } from "effect";
import { join } from "node:path";
import {
  Action,
  CreateSandbox,
  MintCapability,
  TokenResponse,
  RunRecord,
  ErrorResponse,
  ProcessPage,
} from "../src/contracts";
import wasmModuleBytes from "../src/wasm-module-bytes.json";

const configuration = await Effect.runPromise(
  Effect.gen(function* () {
    return { url: yield* Config.String("CIRRO_URL"), key: yield* Config.Redacted("CIRRO_API_KEY") };
  }),
);
const bytes = Buffer.from(
  await Bun.file(join(import.meta.dir, "../dist/wasi-large.wasm")).arrayBuffer(),
);
const id = `large-wasm-proof-${crypto.randomUUID()}`;
const post = (path: string, credential: string, body: string) =>
  fetch(new URL(path, configuration.url), {
    method: "POST",
    keepalive: false,
    headers: { authorization: `Bearer ${credential}`, "content-type": "application/json" },
    body,
    signal: AbortSignal.timeout(60000),
  });
const created = await post(
  "/v1/sandboxes",
  Redacted.value(configuration.key),
  Schema.encodeSync(Schema.fromJsonString(CreateSandbox))({
    id,
    policy: {
      networkHosts: [],
      interruptBudget: 1000,
      memoryBytes: 8388608,
      maxOutputBytes: 1048576,
    },
  }),
);
if (created.status !== 201) process.exit(1);
const minted = await post(
  `/v1/sandboxes/${id}/capabilities`,
  Redacted.value(configuration.key),
  Schema.encodeSync(Schema.fromJsonString(MintCapability))({
    permissions: ["read", "write", "execute", "manage"],
    expiresInSeconds: 3600,
  }),
);
const token = Schema.decodeUnknownSync(TokenResponse)(await minted.json()).token;
const action = (input: typeof Action.Type) =>
  post(
    `/v1/sandboxes/${id}/action`,
    token,
    Schema.encodeSync(Schema.fromJsonString(Action))(input),
  );
const inlineStart = performance.now();
const inlineResponse = await action({
  op: "process.run",
  id: "inline",
  language: "wasm",
  source: bytes.toString("base64"),
});
const inline = Schema.decodeUnknownSync(RunRecord)(await inlineResponse.json());
const inlineMs = performance.now() - inlineStart;
const written = await action({
  op: "filesystem.writeFile",
  path: "/tmp/large.wasm",
  content: bytes.toString("base64"),
  encoding: "base64",
});
const fileStart = performance.now();
const fileResponse = await action({ op: "wasm.executeFile", id: "file", path: "/tmp/large.wasm" });
const file = Schema.decodeUnknownSync(RunRecord)(await fileResponse.json());
const fileMs = performance.now() - fileStart;
const oversizedFile = await action({
  op: "filesystem.writeFile",
  path: "/tmp/oversized.wasm",
  content: Buffer.alloc(wasmModuleBytes + 1).toString("base64"),
  encoding: "base64",
});
const oversized = await action({
  op: "wasm.executeFile",
  id: "oversized",
  path: "/tmp/oversized.wasm",
});
const rejection = Schema.decodeUnknownSync(ErrorResponse)(await oversized.json());
const page = Schema.decodeUnknownSync(ProcessPage)(
  await (await action({ op: "process.list", cursor: null, limit: 50 })).json(),
);
const disposed = await action({ op: "vm.dispose" });
const checks = {
  largeFixture: bytes.length > 2097152 && bytes.length < wasmModuleBytes,
  inline:
    inlineResponse.status === 200 &&
    inline.status === "exited" &&
    inline.output?.result === 165 &&
    inline.output.exitCode === 0,
  file:
    written.status === 200 &&
    fileResponse.status === 200 &&
    file.status === "exited" &&
    file.output?.result === 165 &&
    file.output.exitCode === 0,
  admission:
    oversizedFile.status === 200 &&
    oversized.status === 413 &&
    rejection.error === "EFBIG" &&
    !page.items.some((item) => item.id === "oversized"),
  disposal: disposed.status === 200,
};
const report = {
  measuredAt: new Date().toISOString(),
  url: configuration.url,
  sandboxId: id,
  profile: "minutei",
  runtime: "standard Worker",
  moduleBytes: bytes.length,
  moduleLimitBytes: wasmModuleBytes,
  guestMemoryBytes: 8388608,
  inlineMs,
  fileMs,
  checks,
  allPassed: Object.values(checks).every(Boolean),
  packageParity: false,
};
await Bun.write(
  join(import.meta.dir, "../docs/evidence/large-wasm-production.json"),
  JSON.stringify(report, null, 2) + "\n",
);
console.log(JSON.stringify(report, null, 2));
if (!report.allPassed) process.exit(1);
