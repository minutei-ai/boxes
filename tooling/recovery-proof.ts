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
const childSource = Buffer.from(
  await Bun.file(join(import.meta.dir, "../dist/wasi-stdin-resume-parent.wasm")).arrayBuffer(),
).toString("base64");
const childWritten = await action({
  op: "filesystem.writeFile",
  path: "/tmp/recovery-child.wasm",
  content: childSource,
  encoding: "base64",
});
const childExecutable = await action({
  op: "filesystem.chmod",
  path: "/tmp/recovery-child.wasm",
  mode: 493,
});
const familySource = Buffer.from(
  await Bun.file(join(import.meta.dir, "../dist/wasi-recovery-stopped.wasm")).arrayBuffer(),
).toString("base64");
const familySpawned = await action({
  op: "process.spawn",
  stdinMode: "pipe",
  execution: {
    op: "process.run",
    id: "family",
    language: "wasm",
    source: familySource,
    stdin: { content: "before:", encoding: "utf8" },
  },
});
await action({ op: "process.wait", id: "family", timeoutMs: 25000 });
await action({ op: "process.wait", id: "family", timeoutMs: 25000 });
const familyStatus = Schema.decodeUnknownSync(RecoveryStatus)(
  await (await action({ op: "process.recovery.status", id: "family" })).json(),
);
const familyInput = await action({
  op: "process.stdin.write",
  id: "family",
  offset: 7,
  content: "after",
  encoding: "utf8",
});
const familyClosed = await action({ op: "process.stdin.close", id: "family", offset: 12 });
const familyCompleted = await action({ op: "process.wait", id: "family", timeoutMs: 25000 });
const familyRecord = Schema.decodeUnknownSync(RunRecord)(await familyCompleted.json());
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
  familySetup:
    childWritten.status === 200 && childExecutable.status === 200 && familySpawned.status === 200,
  familyCheckpoint: familyStatus.checkpoints >= 1,
  familyInput: familyInput.status === 200 && familyClosed.status === 200,
  stoppedParentResumed:
    familyCompleted.status === 200 &&
    familyRecord.status === "exited" &&
    familyRecord.output?.exitCode === 0,
  inheritedStdioOnce: familyRecord.output?.stdout === "ready\nbefore:after\nbytes=12\n",
  disposal: disposed.status === 200,
};
const report = {
  measuredAt: new Date().toISOString(),
  url: configuration.url,
  sandboxId: id,
  profile: "minutei",
  runtime: "standard Worker",
  status,
  familyStatus,
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
