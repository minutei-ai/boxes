import { Config, Effect, Redacted, Schema } from "effect";
import { join } from "node:path";
import {
  Action,
  CreateSandbox,
  MintCapability,
  TokenResponse,
  RunRecord,
  RecoveryStatus,
  FileContent,
} from "../src/contracts";

const configuration = await Effect.runPromise(
  Effect.gen(function* () {
    return { url: yield* Config.String("CIRRO_URL"), key: yield* Config.Redacted("CIRRO_API_KEY") };
  }),
);
const id = `recovery-proof-${crypto.randomUUID()}`;
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
      interruptBudget: 100000,
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
const source = Buffer.from(
  await Bun.file(join(import.meta.dir, "../dist/wasi-recovery.wasm")).arrayBuffer(),
).toString("base64");
const spawned = await action({
  op: "process.spawn",
  execution: { op: "process.run", id: "compute", language: "wasm", source },
});
const completed = await action({ op: "process.wait", id: "compute", timeoutMs: 25000 });
const record = Schema.decodeUnknownSync(RunRecord)(await completed.json());
const statusResponse = await action({ op: "process.recovery.status", id: "compute" });
const status = Schema.decodeUnknownSync(RecoveryStatus)(await statusResponse.json());
const fileResponse = await action({ op: "filesystem.readFile", path: "/tmp/recovery-counter" });
const file = Schema.decodeUnknownSync(FileContent)(await fileResponse.json());
const disposed = await action({ op: "vm.dispose" });
const checks = {
  spawn: spawned.status === 200,
  completed:
    completed.status === 200 && record.status === "exited" && record.output?.exitCode === 0,
  checkpointConfirmed:
    statusResponse.status === 200 && status.checkpoints >= 1 && !status.resumable,
  entryOnce: record.output?.stdout === "entered once\n",
  fuelContinuation: record.output?.result === ((3000000 * 2999999) / 2) % 1024,
  fileEffectsOnce:
    fileResponse.status === 200 && Buffer.from(file.content, file.encoding).toString() === "AB",
  disposal: disposed.status === 200,
};
const report = {
  measuredAt: new Date().toISOString(),
  url: configuration.url,
  sandboxId: id,
  profile: "minutei",
  runtime: "standard Worker",
  status,
  checks,
  allPassed: Object.values(checks).every(Boolean),
  handoverRecovery: true,
  arbitraryCrashRecovery: false,
  fullProcessParity: false,
};
await Bun.write(
  join(import.meta.dir, "../docs/evidence/recovery-production.json"),
  JSON.stringify(report, null, 2) + "\n",
);
console.log(JSON.stringify(report, null, 2));
if (!report.allPassed) process.exit(1);
