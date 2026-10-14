import { Config, Effect, Redacted, Schema } from "effect";
import { join } from "node:path";
import {
  Action,
  CreateSandbox,
  MintCapability,
  TokenResponse,
  RunRecord,
  FileContent,
} from "../src/contracts";

const configuration = await Effect.runPromise(
  Effect.gen(function* () {
    return { url: yield* Config.String("CIRRO_URL"), key: yield* Config.Redacted("CIRRO_API_KEY") };
  }),
);
const id = `fd-dup-proof-${crypto.randomUUID()}`;
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
const written = await action({
  op: "filesystem.writeFile",
  path: "/tmp/dup",
  content: "abcdef",
  encoding: "utf8",
});
const otherWritten = await action({
  op: "filesystem.writeFile",
  path: "/tmp/other",
  content: "other",
  encoding: "utf8",
});
const source = Buffer.from(
  await Bun.file(join(import.meta.dir, "../dist/wasi-fd-dup.wasm")).arrayBuffer(),
).toString("base64");
const response = await action({
  op: "process.run",
  id: "aliases",
  language: "wasm",
  source,
  stdin: { content: "X", encoding: "utf8" },
});
const record = Schema.decodeUnknownSync(RunRecord)(await response.json());
const file = Schema.decodeUnknownSync(FileContent)(
  await (await action({ op: "filesystem.readFile", path: "/tmp/dup" })).json(),
);
const other = Schema.decodeUnknownSync(FileContent)(
  await (await action({ op: "filesystem.readFile", path: "/tmp/other" })).json(),
);
const disposed = await action({ op: "vm.dispose" });
const checks = {
  setup: written.status === 200 && otherWritten.status === 200,
  aliasesAndQuota:
    response.status === 200 && record.status === "exited" && record.output?.result === 0,
  stdio: record.output?.stdout === "" && record.output.stderr === "alias stderr",
  persistedWrites:
    Buffer.from(file.content, file.encoding).toString() === "abcdefZ" &&
    Buffer.from(other.content, other.encoding).toString() === "other",
  disposal: disposed.status === 200,
};
const report = {
  measuredAt: new Date().toISOString(),
  url: configuration.url,
  sandboxId: id,
  profile: "minutei",
  runtime: "standard Worker",
  checks,
  allPassed: Object.values(checks).every(Boolean),
  packageParity: false,
};
await Bun.write(
  join(import.meta.dir, "../docs/evidence/fd-dup-production.json"),
  JSON.stringify(report, null, 2) + "\n",
);
console.log(JSON.stringify(report, null, 2));
if (!report.allPassed) process.exit(1);
