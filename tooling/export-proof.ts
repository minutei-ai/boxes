import { Config, Effect, Redacted, Schema } from "effect";
import { join } from "node:path";
import {
  Action,
  CreateSandbox,
  MintCapability,
  TokenResponse,
  FilesystemSnapshot,
  ErrorResponse,
} from "../src/contracts";

const configuration = await Effect.runPromise(
  Effect.gen(function* () {
    return { url: yield* Config.String("CIRRO_URL"), key: yield* Config.Redacted("CIRRO_API_KEY") };
  }),
);
const id = `export-proof-${crypto.randomUUID()}`;
const post = (path: string, credential: string, body: string) =>
  fetch(new URL(path, configuration.url), {
    method: "POST",
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
    permissions: ["read", "write", "manage"],
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
const binary = Buffer.from([0, 255, 128, 10, 0, 1]).toString("base64");
const written = await action({
  op: "filesystem.writeFile",
  path: "/tmp/data",
  content: binary,
  encoding: "base64",
});
const mode = await action({ op: "filesystem.chmod", path: "/tmp/data", mode: 416 });
const linked = await action({ op: "filesystem.symlink", path: "/tmp/dangling", target: "missing" });
const response = await action({ op: "filesystem.export", maxBytes: 25165824 });
const bytes = await response.text();
const snapshot = Schema.decodeUnknownSync(Schema.fromJsonString(FilesystemSnapshot))(bytes);
const file = snapshot.source.filesystem.entries.find((entry) => entry.path === "/tmp/data");
const link = snapshot.source.filesystem.entries.find((entry) => entry.path === "/tmp/dangling");
const exact = await action({ op: "filesystem.export", maxBytes: Buffer.byteLength(bytes) });
const limited = await action({ op: "filesystem.export", maxBytes: Buffer.byteLength(bytes) - 1 });
const failure = Schema.decodeUnknownSync(ErrorResponse)(await limited.json());
const disposed = await action({ op: "vm.dispose" });
const checks = {
  setup: written.status === 200 && mode.status === 200 && linked.status === 200,
  exported: response.status === 200,
  binary: file?.type === "file" && file.content === binary && file.encoding === "base64",
  metadata: file?.type === "file" && file.mode === "0640" && file.uid === 0 && file.gid === 0,
  symlink: link?.type === "symlink" && link.target === "missing",
  root: snapshot.source.filesystem.entries[0]?.path === "/",
  exactLimit: exact.status === 200,
  bounded: limited.status === 413 && failure.error === "EFBIG",
  disposal: disposed.status === 200,
};
const report = {
  measuredAt: new Date().toISOString(),
  url: configuration.url,
  sandboxId: id,
  profile: "minutei",
  runtime: "standard Worker",
  snapshotBytes: Buffer.byteLength(bytes),
  checks,
  allPassed: Object.values(checks).every(Boolean),
};
await Bun.write(
  join(import.meta.dir, "../docs/evidence/export-production.json"),
  JSON.stringify(report, null, 2) + "\n",
);
console.log(JSON.stringify(report, null, 2));
if (!report.allPassed) process.exit(1);
