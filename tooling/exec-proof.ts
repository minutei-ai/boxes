import { Config, Effect, Redacted, Schema } from "effect";
import { join } from "node:path";
import { Action, CreateSandbox, MintCapability, TokenResponse, RunRecord } from "../src/contracts";

const configuration = await Effect.runPromise(
  Effect.gen(function* () {
    return { url: yield* Config.String("CIRRO_URL"), key: yield* Config.Redacted("CIRRO_API_KEY") };
  }),
);
const id = `exec-proof-${crypto.randomUUID()}`;
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
const preparation = [];
for (const [mode, path] of [
  ["image", "/tmp/next.wasm"],
  ["path", "/tmp/parent.wasm"],
  ["leaf", "/tmp/leaf.wasm"],
  ["image-start", "/tmp/start.wasm"],
  ["image-start-trap", "/tmp/start-trap.wasm"],
] as const) {
  const content = Buffer.from(
    await Bun.file(join(import.meta.dir, `../dist/wasi-exec-${mode}.wasm`)).arrayBuffer(),
  ).toString("base64");
  const uploaded = await action({ op: "filesystem.writeFile", path, content, encoding: "base64" });
  const permission = await action({ op: "filesystem.chmod", path, mode: 493 });
  preparation.push(uploaded.status === 200 && permission.status === 200);
}
for (const [path, content, mode] of [
  ["/tmp/invalid", "invalid module", 493],
  ["/tmp/data", "ABC", 420],
] as const) {
  const uploaded = await action({ op: "filesystem.writeFile", path, content, encoding: "utf8" });
  const permission = await action({ op: "filesystem.chmod", path, mode });
  preparation.push(uploaded.status === 200 && permission.status === 200);
}
const receipts = [];
for (const [mode, result, exitCode, stdout, status] of [
  ["path", 7, 0, "1B", "exited"],
  ["fexec", 7, 0, "1B", "exited"],
  ["child", 0, 0, "2B", "exited"],
  ["children", 7, 0, "1B", "exited"],
  ["loop", 7, 0, "1B", "exited"],
  ["start", 7, 0, "Z1B", "exited"],
  ["start-trap", null, null, "Z", "failed"],
  ["signal", null, 138, "1B", "exited"],
  ["pending", null, 130, "1B", "exited"],
  ["missing", 44, 0, "", "exited"],
  ["invalid", 45, 0, "", "exited"],
  ["denied", 2, 0, "", "exited"],
  ["badfd", 8, 0, "", "exited"],
] as const) {
  const source = Buffer.from(
    await Bun.file(join(import.meta.dir, `../dist/wasi-exec-${mode}.wasm`)).arrayBuffer(),
  ).toString("base64");
  const response = await action({ op: "process.run", id: mode, language: "wasm", source });
  const record = Schema.decodeUnknownSync(RunRecord)(await response.json());
  receipts.push({
    mode,
    observed: {
      status: record.status,
      result: record.output?.result,
      exitCode: record.output?.exitCode,
      stdout: record.output?.stdout,
    },
    passed:
      response.status === 200 &&
      record.status === status &&
      record.output?.result === result &&
      record.output?.exitCode === exitCode &&
      record.output?.stdout === stdout,
  });
}
const disposed = await action({ op: "vm.dispose" });
const report = {
  measuredAt: new Date().toISOString(),
  url: configuration.url,
  sandboxId: id,
  profile: "minutei",
  runtime: "standard Worker",
  receipts,
  allPassed:
    preparation.every(Boolean) &&
    receipts.every((receipt) => receipt.passed) &&
    disposed.status === 200,
  fullProcessParity: false,
};
await Bun.write(
  join(import.meta.dir, "../docs/evidence/exec-production.json"),
  JSON.stringify(report, null, 2) + "\n",
);
console.log(JSON.stringify(report, null, 2));
if (!report.allPassed) process.exit(1);
