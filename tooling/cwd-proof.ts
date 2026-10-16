import { Config, Effect, Redacted, Schema } from "effect";
import { join } from "node:path";
import { defaultSoftware } from "../src/default-software";
import { downloadSoftware } from "./software-artifacts";
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
const digest = defaultSoftware[1].digest;
const bytes = await Effect.runPromise(downloadSoftware(defaultSoftware[1]));
const removed = await action({ op: "software.uninstall", packageId: digest });
await removed.text();
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
const deniedDirectory = await action({
  op: "filesystem.mkdir",
  path: "/tmp/denied",
  recursive: true,
});
const deniedImage = await action({
  op: "filesystem.writeFile",
  path: "/tmp/denied/jq",
  content: "not executable",
  encoding: "utf8",
});
const deniedMode = await action({ op: "filesystem.chmod", path: "/tmp/denied/jq", mode: 420 });
const receipts = await Effect.runPromise(
  Effect.forEach(
    [
      "explicit",
      "relative",
      "chdir",
      "fchdir",
      "symlink",
      "path-absolute",
      "path-empty",
      "path-chdir",
      "path-slash",
      "sched-zero",
      "open-dir",
      "closefrom-root",
      "closefrom-high",
    ] as const,
    (mode) =>
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
      ["path-missing", 44],
      ["path-absent", 44],
      ["path-denied", 2],
      ["sched-priority", 28],
      ["sched-policy", 63],
      ["file", 54],
      ["closed", 8],
      ["malformed", 28],
      ["exclusive", 20],
      ["open-close", 8],
      ["closefrom", 8],
      ["closefrom-negative", 8],
      ["readonly", 2],
      ["nofollow", 32],
    ] as const,
    ([mode, errno]) =>
      Effect.tryPromise(async () => {
        const source = Buffer.from(
          await Bun.file(join(import.meta.dir, `../dist/wasi-cwd-${mode}.wasm`)).arrayBuffer(),
        ).toString("base64");
        const response = await action({ op: "process.run", id: mode, language: "wasm", source });
        const record = Schema.decodeUnknownSync(RunRecord)(await response.json());
        return {
          mode,
          errno,
          observed: record.output?.result,
          passed:
            response.status === 200 &&
            record.status === "exited" &&
            record.output?.result === errno &&
            record.output.stdout === "",
        };
      }),
  ),
);
const redirectSource = Buffer.from(
  await Bun.file(join(import.meta.dir, "../dist/wasi-cwd-redirect.wasm")).arrayBuffer(),
).toString("base64");
const redirectResponse = await action({
  op: "process.run",
  id: "redirect",
  language: "wasm",
  source: redirectSource,
});
const redirect = Schema.decodeUnknownSync(RunRecord)(await redirectResponse.json());
const redirectedFile = await action({ op: "filesystem.readFile", path: "/tmp/work/output.txt" });
const redirectedContent = Schema.decodeUnknownSync(FileContent)(await redirectedFile.json());
const disposed = await action({ op: "vm.dispose" });
const checks = {
  deniedImage:
    deniedDirectory.status === 200 && deniedImage.status === 200 && deniedMode.status === 200,
  setup:
    removed.status === 200 &&
    uploaded.status === 200 &&
    installed.status === 200 &&
    directory.status === 200 &&
    written.status === 200 &&
    linked.status === 200 &&
    imageLinked.status === 200,
  publishedRelativeInput: receipts.every((receipt) => receipt.passed),
  invalidCwdAndActions: rejected.every((receipt) => receipt.passed),
  orderedOpenRedirection:
    redirectResponse.status === 200 &&
    redirect.output?.result === 0 &&
    redirect.output.stdout === "" &&
    redirectedFile.status === 200 &&
    Buffer.from(redirectedContent.content, redirectedContent.encoding).toString() === "77\n",
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
  rejected,
  artifactDigest: digest,
  allPassed: Object.values(checks).every(Boolean),
  openFileActions: true,
  fullProcessParity: false,
  packageParity: false,
};
await Bun.write(
  join(import.meta.dir, "../docs/evidence/cwd-production.json"),
  JSON.stringify(report, null, 2) + "\n",
);
console.log(JSON.stringify(report, null, 2));
if (!report.allPassed) process.exit(1);
