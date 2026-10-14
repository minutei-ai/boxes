import { Config, Effect, Redacted, Schema } from "effect";
import { join } from "node:path";
import { Action, CreateSandbox, MintCapability, TokenResponse, RunRecord } from "../src/contracts";

const configuration = await Effect.runPromise(
  Effect.gen(function* () {
    return { url: yield* Config.String("CIRRO_URL"), key: yield* Config.Redacted("CIRRO_API_KEY") };
  }),
);
const id = `host-stat-proof-${crypto.randomUUID()}`;
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
const action = (input: typeof Action.Type, credential = token) =>
  post(
    `/v1/sandboxes/${id}/action`,
    credential,
    Schema.encodeSync(Schema.fromJsonString(Action))(input),
  );
const written = await action({
  op: "filesystem.writeFile",
  path: "/tmp/meta",
  content: "x".repeat(513),
  encoding: "utf8",
});
const mode = await action({ op: "filesystem.chmod", path: "/tmp/meta", mode: 0o640 });
const link = await action({ op: "filesystem.symlink", path: "/tmp/link", target: "/tmp/meta" });
const directory = await action({
  op: "filesystem.mkdir",
  path: "/tmp/restricted",
  recursive: false,
});
const escape = await action({
  op: "filesystem.symlink",
  path: "/tmp/restricted/escape",
  target: "/tmp/meta",
});
const source = Buffer.from(
  await Bun.file(join(import.meta.dir, "../dist/wasi-host-stat.wasm")).arrayBuffer(),
).toString("base64");
const response = await action({ op: "process.run", id: "metadata", language: "wasm", source });
const record = Schema.decodeUnknownSync(RunRecord)(await response.json());
const deniedMint = await post(
  `/v1/sandboxes/${id}/capabilities`,
  Redacted.value(configuration.key),
  Schema.encodeSync(Schema.fromJsonString(MintCapability))({
    permissions: ["execute"],
    expiresInSeconds: 3600,
  }),
);
const deniedToken = Schema.decodeUnknownSync(TokenResponse)(await deniedMint.json()).token;
const deniedSource = Buffer.from(
  await Bun.file(join(import.meta.dir, "../dist/wasi-host-stat-denied.wasm")).arrayBuffer(),
).toString("base64");
const deniedResponse = await action(
  { op: "process.run", id: "denied", language: "wasm", source: deniedSource },
  deniedToken,
);
const denied = Schema.decodeUnknownSync(RunRecord)(await deniedResponse.json());
const disposed = await action({ op: "vm.dispose" });
const checks = {
  setup: [written, mode, link, directory, escape].every((response) => response.status === 200),
  metadataAndDescriptors:
    response.status === 200 &&
    record.status === "exited" &&
    record.output?.result === 0 &&
    record.output.exitCode === 0,
  readGrant:
    deniedResponse.status === 200 && denied.status === "exited" && denied.output?.result === 0,
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
  join(import.meta.dir, "../docs/evidence/host-stat-production.json"),
  JSON.stringify(report, null, 2) + "\n",
);
console.log(JSON.stringify(report, null, 2));
if (!report.allPassed) process.exit(1);
