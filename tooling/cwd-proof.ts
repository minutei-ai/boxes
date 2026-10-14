import { Config, Effect, Redacted, Schema } from "effect";
import { join } from "node:path";
import { Action, CreateSandbox, MintCapability, TokenResponse, RunRecord } from "../src/contracts";

const configuration = await Effect.runPromise(
  Effect.gen(function* () {
    return { url: yield* Config.String("CIRRO_URL"), key: yield* Config.Redacted("CIRRO_API_KEY") };
  }),
);
const id = `cwd-proof-${crypto.randomUUID()}`;
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
const digest = "edb1cf0bbcf663d177916592d2f1b4361a02966dbf2eb44e3e61ea2a399bb43a";
const artifact = await fetch(
  `https://releases.rivet.dev/agent-os/latest/software/packages/jq/${digest}.aospkg`,
  { signal: AbortSignal.timeout(60000) },
);
const bytes = await artifact.arrayBuffer();
const artifactDigest = Buffer.from(await crypto.subtle.digest("SHA-256", bytes)).toString("hex");
if (!artifact.ok || artifactDigest !== digest) process.exit(1);
const uploaded = await action({
  op: "filesystem.writeFile",
  path: "/tmp/jq.aospkg",
  content: Buffer.from(bytes).toString("base64"),
  encoding: "base64",
});
const installed = await action({
  op: "software.install",
  source: { path: "/tmp/jq.aospkg", digest: `sha256:${digest}` },
});
await installed.text();
const directory = await action({ op: "filesystem.mkdir", path: "/tmp/work", recursive: true });
const written = await action({
  op: "filesystem.writeFile",
  path: "/tmp/work/input.json",
  content: '{"value":77}',
  encoding: "utf8",
});
const linked = await action({ op: "filesystem.symlink", target: "/tmp/work", path: "/tmp/link" });
const imageLinked = await action({
  op: "filesystem.symlink",
  target: "/opt/cirro/bin/jq",
  path: "/tmp/work/jq",
});
const receipts = await Effect.runPromise(
  Effect.forEach(["explicit", "relative", "chdir", "fchdir", "symlink"] as const, (mode) =>
    Effect.tryPromise(async () => {
      const source = Buffer.from(
        await Bun.file(join(import.meta.dir, `../dist/wasi-cwd-${mode}.wasm`)).arrayBuffer(),
      ).toString("base64");
      const response = await action({ op: "process.run", id: mode, language: "wasm", source });
      const record = Schema.decodeUnknownSync(RunRecord)(await response.json());
      return {
        mode,
        passed:
          response.status === 200 &&
          record.status === "exited" &&
          record.output?.exitCode === 0 &&
          record.output.result === 0 &&
          record.output.stdout === "77\n",
      };
    }),
  ),
);
const rejected = await Effect.runPromise(
  Effect.forEach(
    [
      ["missing", 44],
      ["file", 54],
      ["closed", 8],
      ["malformed", 28],
    ] as const,
    ([mode, errno]) =>
      Effect.tryPromise(async () => {
        const source = Buffer.from(
          await Bun.file(join(import.meta.dir, `../dist/wasi-cwd-${mode}.wasm`)).arrayBuffer(),
        ).toString("base64");
        const response = await action({ op: "process.run", id: mode, language: "wasm", source });
        const record = Schema.decodeUnknownSync(RunRecord)(await response.json());
        return (
          response.status === 200 &&
          record.status === "exited" &&
          record.output?.result === errno &&
          record.output.stdout === ""
        );
      }),
  ),
);
const disposed = await action({ op: "vm.dispose" });
const checks = {
  setup:
    uploaded.status === 200 &&
    installed.status === 200 &&
    directory.status === 200 &&
    written.status === 200 &&
    linked.status === 200 &&
    imageLinked.status === 200,
  publishedRelativeInput: receipts.every((receipt) => receipt.passed),
  invalidCwdAndActions: rejected.every(Boolean),
  disposal: disposed.status === 200,
};
const report = {
  measuredAt: new Date().toISOString(),
  url: configuration.url,
  sandboxId: id,
  profile: "minutei",
  runtime: "standard Worker",
  checks,
  receipts,
  artifactDigest,
  allPassed: Object.values(checks).every(Boolean),
  openFileActions: false,
  fullProcessParity: false,
  packageParity: false,
};
await Bun.write(
  join(import.meta.dir, "../docs/evidence/cwd-production.json"),
  JSON.stringify(report, null, 2) + "\n",
);
console.log(JSON.stringify(report, null, 2));
if (!report.allPassed) process.exit(1);
