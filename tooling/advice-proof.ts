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
const id = `advice-proof-${crypto.randomUUID()}`;
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
const source = Buffer.from(
  await Bun.file(join(import.meta.dir, "../dist/wasi-advice.wasm")).arrayBuffer(),
).toString("base64");
const response = await action({ op: "process.run", id: "advice", language: "wasm", source });
const record = Schema.decodeUnknownSync(RunRecord)(await response.json());
const contents = await action({ op: "filesystem.readFile", path: "/tmp/advice" });
const file = Schema.decodeUnknownSync(FileContent)(await contents.json());
const disposed = await action({ op: "vm.dispose" });
const checks = {
  nativeAdvice:
    response.status === 200 && record.status === "exited" && record.output?.exitCode === 0,
  guestAssertions:
    record.output?.stdout ===
    "advice validated descriptors, rights, enums and ranges without changing bytes or cursor\n",
  persistedBytes:
    contents.status === 200 &&
    file.content === Buffer.from("advice preserves data").toString("base64"),
  disposal: disposed.status === 200,
};
console.log(
  JSON.stringify(
    {
      target: configuration.url,
      measuredAt: new Date().toISOString(),
      sourceHash: record.sourceHash,
      checks,
    },
    null,
    2,
  ),
);
if (!Object.values(checks).every(Boolean)) process.exit(1);
