import { Config, Effect, Redacted, Schema } from "effect";
import { join } from "node:path";
import { Action, CreateSandbox, MintCapability, TokenResponse, RunRecord } from "../src/contracts";

const configuration = await Effect.runPromise(
  Effect.gen(function* () {
    return { url: yield* Config.String("CIRRO_URL"), key: yield* Config.Redacted("CIRRO_API_KEY") };
  }),
);
const id = `guest-spawn-proof-${crypto.randomUUID()}`;
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
const observed = async (processId: string) => {
  for (const attempt of Array.from({ length: 8 }, (_, index) => index)) {
    const response = await action({ op: "process.wait", id: processId, timeoutMs: 25000 });
    console.log(
      JSON.stringify({
        op: "process.wait",
        id: processId,
        observation: attempt + 1,
        status: response.status,
      }),
    );
    if (response.status === 408) {
      await response.text();
      continue;
    }
    if (response.status !== 200) {
      await response.text();
      return null;
    }
    return Schema.decodeUnknownSync(RunRecord)(await response.json());
  }
  return null;
};
const languages = ["javascript", "typescript", "python"] as const;
const runs = await Effect.runPromise(
  Effect.forEach(languages, (language) =>
    Effect.tryPromise(async () => {
      const childId = `child-${language}`;
      const spawn = JSON.stringify({
        op: "process.spawn",
        execution: {
          op: "process.run",
          id: childId,
          language: "javascript",
          source: "export default () => 73",
        },
      });
      const sources = {
        javascript: `export default async ({tools}) => (await tools.call(${spawn})).id`,
        typescript: `export default async ({tools}) => (await tools.call(${spawn})).id`,
        python: `(await tools.call(${spawn}))["id"]`,
      };
      const response = await action({
        op: "process.spawn",
        execution: {
          op: "process.run",
          id: `parent-${language}`,
          language,
          source: sources[language],
        },
      });
      if (response.status !== 200) {
        await response.text();
        return false;
      }
      await response.text();
      const parent = await observed(`parent-${language}`);
      const child = await observed(childId);
      return (
        parent?.output?.exitCode === 0 &&
        parent.output.result === childId &&
        child?.output?.exitCode === 0 &&
        child.output.result === 73
      );
    }),
  ),
);
const disposed = await action({ op: "vm.dispose" });
const checks = {
  javascript: runs[0] === true,
  typescript: runs[1] === true,
  python: runs[2] === true,
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
  posixChildren: false,
  processInheritance: false,
  packageParity: false,
};
await Bun.write(
  join(import.meta.dir, "../docs/evidence/guest-spawn-production.json"),
  JSON.stringify(report, null, 2) + "\n",
);
console.log(JSON.stringify(report, null, 2));
if (!report.allPassed) process.exit(1);
