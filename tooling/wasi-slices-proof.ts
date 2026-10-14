import { Config, Effect, Redacted, Schema } from "effect";
import { join } from "node:path";
import {
  Action,
  CreateSandbox,
  MintCapability,
  TokenResponse,
  RunRecord,
  LiveOutputPage,
  ErrorResponse,
} from "../src/contracts";

const configuration = await Effect.runPromise(
  Effect.gen(function* () {
    return { url: yield* Config.String("CIRRO_URL"), key: yield* Config.Redacted("CIRRO_API_KEY") };
  }),
);
const id = `wasi-slices-proof-${crypto.randomUUID()}`;
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
    permissions: ["read", "execute", "manage"],
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
  await Bun.file(join(import.meta.dir, "../dist/wasi-slices-finite.wasm")).arrayBuffer(),
).toString("base64");
const response = await action({ op: "process.run", id: "io", language: "wasm", source });
const record = Schema.decodeUnknownSync(RunRecord)(await response.json());
const blockedSource = Buffer.from(
  await Bun.file(join(import.meta.dir, "../dist/wasi-slices-infinite.wasm")).arrayBuffer(),
).toString("base64");
const started = Schema.decodeUnknownSync(RunRecord)(
  await (
    await action({
      op: "process.spawn",
      execution: { op: "process.run", id: "blocked", language: "wasm", source: blockedSource },
    })
  ).json(),
);
const deadline = performance.now() + 120000;
const checkpoints: (typeof LiveOutputPage.Type)[] = [];
while (performance.now() < deadline) {
  const page = Schema.decodeUnknownSync(LiveOutputPage)(
    await (
      await action({
        op: "process.output.readLive",
        id: "blocked",
        after: null,
        maxBytes: 4096,
        maxEvents: 1,
      })
    ).json(),
  );
  if (page.events.length > 0) {
    checkpoints.push(page);
    break;
  }
  await Bun.sleep(100);
}
const observation = await action({ op: "process.wait", id: "blocked", timeoutMs: 0 });
const cancelled = await action({ op: "process.cancel", id: "blocked" });
const waited = await action({ op: "process.wait", id: "blocked", timeoutMs: 25000 });
const failure = Schema.decodeUnknownSync(ErrorResponse)(await waited.json());
const retained = Schema.decodeUnknownSync(RunRecord)(
  await (await action({ op: "process.get", id: "blocked" })).json(),
);
const disposed = await action({ op: "vm.dispose" });
const checks = {
  resumption:
    response.status === 200 &&
    record.status === "exited" &&
    record.output?.result === 352 &&
    record.output.stdout === "cpu loop started\n",
  runningCheckpoint:
    started.status === "queued" &&
    checkpoints[0]?.state === "running" &&
    observation.status === 408,
  cancellation:
    cancelled.status === 200 &&
    waited.status === 409 &&
    failure.error === "ECANCELED" &&
    retained.status === "cancelled",
  retainedOutput:
    retained.output?.stdout === "cpu loop started\n" && retained.output.exitCode === null,
  disposal: disposed.status === 200,
};
const report = {
  measuredAt: new Date().toISOString(),
  url: configuration.url,
  sandboxId: id,
  profile: "minutei",
  runtime: "standard Worker",
  checks,
  receipts: {
    observationStatus: observation.status,
    cancelStatus: cancelled.status,
    waitStatus: waited.status,
    waitError: failure.error,
    finalStatus: retained.status,
  },
  allPassed: Object.values(checks).every(Boolean),
  processInheritance: false,
  packageParity: false,
};
await Bun.write(
  join(import.meta.dir, "../docs/evidence/wasi-slices-production.json"),
  JSON.stringify(report, null, 2) + "\n",
);
console.log(JSON.stringify(report, null, 2));
if (!report.allPassed) process.exit(1);
