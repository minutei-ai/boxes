import { Config, Effect, Redacted, Schema } from "effect";
import {
  Action,
  CreateSandbox,
  MintCapability,
  TokenResponse,
  FileStat,
  FileContent,
  FilesystemSnapshot,
} from "../src/contracts";

const configuration = await Effect.runPromise(
  Effect.gen(function* () {
    return { url: yield* Config.String("CIRRO_URL"), key: yield* Config.Redacted("CIRRO_API_KEY") };
  }),
);
const id = `import-proof-${crypto.randomUUID()}`;
const post = (path: string, credential: string, body: string) =>
  fetch(new URL(path, configuration.url), {
    method: "POST",
    keepalive: false,
    headers: { authorization: `Bearer ${credential}`, "content-type": "application/json" },
    body,
    signal: AbortSignal.timeout(60000),
  });
const snapshot = Schema.decodeUnknownSync(FilesystemSnapshot)({
  kind: "snapshot-export",
  source: {
    format: "boxes-filesystem-snapshot-v1",
    filesystem: {
      entries: [
        { path: "/", type: "directory", mode: "0755", uid: 1000, gid: 1001 },
        {
          path: "/data",
          type: "file",
          mode: "0444",
          uid: 2000,
          gid: 2001,
          content: Buffer.from([0, 255, 128, 10]).toString("base64"),
          encoding: "base64",
        },
        { path: "/alias", type: "symlink", mode: "0777", uid: 3000, gid: 3001, target: "data" },
      ],
    },
  },
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
    snapshot,
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
const contents = Schema.decodeUnknownSync(FileContent)(
  await (await action({ op: "filesystem.readFile", path: "/alias" })).json(),
);
const link = Schema.decodeUnknownSync(FileStat)(
  await (await action({ op: "filesystem.stat", path: "/alias", follow: false })).json(),
);
const restored = Schema.decodeUnknownSync(FilesystemSnapshot)(
  await (await action({ op: "filesystem.export", maxBytes: 1048576 })).json(),
);
const duplicate = await post(
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
    snapshot,
  }),
);
const disposed = await action({ op: "vm.dispose" });
const checks = {
  importedBytes: contents.content === Buffer.from([0, 255, 128, 10]).toString("base64"),
  relativeSymlink: link.kind === "symlink" && link.uid === 3000 && link.gid === 3001,
  roundtrip:
    JSON.stringify(
      restored.source.filesystem.entries.toSorted((left, right) =>
        left.path.localeCompare(right.path),
      ),
    ) ===
    JSON.stringify(
      snapshot.source.filesystem.entries.toSorted((left, right) =>
        left.path.localeCompare(right.path),
      ),
    ),
  exclusiveCreation: duplicate.status === 409,
  disposal: disposed.status === 200,
};
console.log(
  JSON.stringify(
    { target: configuration.url, measuredAt: new Date().toISOString(), checks },
    null,
    2,
  ),
);
if (!Object.values(checks).every(Boolean)) process.exit(1);
