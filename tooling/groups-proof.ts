import { Config, Effect, Redacted, Schema } from "effect";
import { join } from "node:path";
import { Action, CreateSandbox, MintCapability, TokenResponse, RunRecord } from "../src/contracts";

const configuration = await Effect.runPromise(
  Effect.gen(function* () {
    return { url: yield* Config.String("CIRRO_URL"), key: yield* Config.Redacted("CIRRO_API_KEY") };
  }),
);
const id = `groups-proof-${crypto.randomUUID()}`;
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
const receipts = await Effect.runPromise(
  Effect.forEach(["new", "join", "inherit"] as const, (mode) =>
    Effect.tryPromise(async () => {
      const child = Buffer.from(
        await Bun.file(
          join(import.meta.dir, `../dist/wasi-groups-child-${mode}.wasm`),
        ).arrayBuffer(),
      ).toString("base64");
      const uploaded = await action({
        op: "filesystem.writeFile",
        path: "/tmp/group.wasm",
        content: child,
        encoding: "base64",
      });
      const executable = await action({
        op: "filesystem.chmod",
        path: "/tmp/group.wasm",
        mode: 493,
      });
      const source = Buffer.from(
        await Bun.file(
          join(import.meta.dir, `../dist/wasi-groups-parent-${mode}.wasm`),
        ).arrayBuffer(),
      ).toString("base64");
      const response = await action({ op: "process.run", id: mode, language: "wasm", source });
      const record = Schema.decodeUnknownSync(RunRecord)(await response.json());
      return {
        mode,
        passed:
          uploaded.status === 200 &&
          executable.status === 200 &&
          response.status === 200 &&
          record.status === "exited" &&
          record.output?.result === 0 &&
          record.output.exitCode === 0,
      };
    }),
  ),
);
const disposed = await action({ op: "vm.dispose" });
const report = {
  measuredAt: new Date().toISOString(),
  url: configuration.url,
  sandboxId: id,
  profile: "minutei",
  runtime: "standard Worker",
  receipts,
  disposal: disposed.status === 200,
  allPassed: receipts.every((receipt) => receipt.passed) && disposed.status === 200,
  sessionsAndGroupSignals: false,
  fullProcessParity: false,
};
await Bun.write(
  join(import.meta.dir, "../docs/evidence/groups-production.json"),
  JSON.stringify(report, null, 2) + "\n",
);
console.log(JSON.stringify(report, null, 2));
if (!report.allPassed) process.exit(1);
