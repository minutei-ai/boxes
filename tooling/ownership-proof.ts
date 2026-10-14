import { Config, Effect, Redacted, Schema } from "effect";
import {
  Action,
  CreateSandbox,
  MintCapability,
  TokenResponse,
  RunRecord,
  FileStat,
  FilesystemSnapshot,
} from "../src/contracts";

const configuration = await Effect.runPromise(
  Effect.gen(function* () {
    return { url: yield* Config.String("CIRRO_URL"), key: yield* Config.Redacted("CIRRO_API_KEY") };
  }),
);
const id = `ownership-proof-${crypto.randomUUID()}`;
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
const written = await action({
  op: "filesystem.writeFile",
  path: "/tmp/data",
  content: "ownership proof",
  encoding: "utf8",
});
const linked = await action({ op: "filesystem.symlink", path: "/tmp/alias", target: "/tmp/data" });
const ownedLink = await action({
  op: "filesystem.chown",
  path: "/tmp/alias",
  uid: 1000,
  gid: 1001,
  follow: false,
});
const record = Schema.decodeUnknownSync(RunRecord)(
  await (
    await action({
      op: "process.run",
      id: "ownership",
      language: "typescript",
      source:
        'export default async ({tools}) => tools.call({op:"filesystem.chown",path:"/tmp/alias",uid:2000,gid:2001,follow:true})',
    })
  ).json(),
);
const target = Schema.decodeUnknownSync(FileStat)(
  await (await action({ op: "filesystem.stat", path: "/tmp/data", follow: true })).json(),
);
const link = Schema.decodeUnknownSync(FileStat)(
  await (await action({ op: "filesystem.stat", path: "/tmp/alias", follow: false })).json(),
);
const readonly = Schema.decodeUnknownSync(TokenResponse)(
  await (
    await post(
      `/v1/sandboxes/${id}/capabilities`,
      Redacted.value(configuration.key),
      Schema.encodeSync(Schema.fromJsonString(MintCapability))({
        permissions: ["read"],
        expiresInSeconds: 3600,
      }),
    )
  ).json(),
).token;
const denied = await action(
  { op: "filesystem.chown", path: "/tmp/data", uid: 1, gid: 2, follow: true },
  readonly,
);
const snapshot = Schema.decodeUnknownSync(FilesystemSnapshot)(
  await (await action({ op: "filesystem.export", maxBytes: 1048576 })).json(),
);
const disposed = await action({ op: "vm.dispose" });
const checks = {
  setup: written.status === 200 && linked.status === 200 && ownedLink.status === 200,
  guestOwnership:
    record.status === "exited" &&
    record.output?.exitCode === 0 &&
    target.uid === 2000 &&
    target.gid === 2001,
  symlinkOwnership: link.uid === 1000 && link.gid === 1001,
  readonlyDenied: denied.status === 403,
  exportedOwnership:
    snapshot.source.filesystem.entries.find((entry) => entry.path === "/tmp/data")?.uid === 2000 &&
    snapshot.source.filesystem.entries.find((entry) => entry.path === "/tmp/alias")?.uid === 1000,
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
