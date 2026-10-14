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
const id = `wasi-child-proof-${crypto.randomUUID()}`;
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
const child = Buffer.from(
  await Bun.file(join(import.meta.dir, "../dist/wasi-child-child.wasm")).arrayBuffer(),
).toString("base64");
const uploaded = await action({
  op: "filesystem.writeFile",
  path: "/tmp/child.wasm",
  content: child,
  encoding: "base64",
});
const executable = await action({ op: "filesystem.chmod", path: "/tmp/child.wasm", mode: 493 });
const written = await action({
  op: "filesystem.writeFile",
  path: "/tmp/shared",
  content: "abc",
  encoding: "utf8",
});
const source = Buffer.from(
  await Bun.file(join(import.meta.dir, "../dist/wasi-child-parent.wasm")).arrayBuffer(),
).toString("base64");
const response = await action({ op: "process.run", id: "family", language: "wasm", source });
const record = Schema.decodeUnknownSync(RunRecord)(await response.json());
const file = Schema.decodeUnknownSync(FileContent)(
  await (await action({ op: "filesystem.readFile", path: "/tmp/shared" })).json(),
);
const renamedChild = Buffer.from(
  await Bun.file(join(import.meta.dir, "../dist/wasi-child-child-rename.wasm")).arrayBuffer(),
).toString("base64");
const uploadedRename = await action({
  op: "filesystem.writeFile",
  path: "/tmp/child.wasm",
  content: renamedChild,
  encoding: "base64",
});
const renamed = Schema.decodeUnknownSync(RunRecord)(
  await (await action({ op: "process.run", id: "rename", language: "wasm", source })).json(),
);
const moved = Schema.decodeUnknownSync(FileContent)(
  await (await action({ op: "filesystem.readFile", path: "/tmp/moved" })).json(),
);
const missing = await action({ op: "filesystem.readFile", path: "/tmp/shared" });
await missing.text();
const trapped = await Effect.runPromise(
  Effect.forEach(["child-trap", "child-oob"] as const, (mode) =>
    Effect.tryPromise(async () => {
      const child = Buffer.from(
        await Bun.file(join(import.meta.dir, `../dist/wasi-child-${mode}.wasm`)).arrayBuffer(),
      ).toString("base64");
      const uploaded = await action({
        op: "filesystem.writeFile",
        path: "/tmp/child.wasm",
        content: child,
        encoding: "base64",
      });
      const executable = await action({
        op: "filesystem.chmod",
        path: "/tmp/child.wasm",
        mode: 493,
      });
      const reset = await action({
        op: "filesystem.writeFile",
        path: "/tmp/shared",
        content: "abc",
        encoding: "utf8",
      });
      const source = Buffer.from(
        await Bun.file(join(import.meta.dir, "../dist/wasi-child-parent-trap.wasm")).arrayBuffer(),
      ).toString("base64");
      const response = await action({ op: "process.run", id: mode, language: "wasm", source });
      const record = Schema.decodeUnknownSync(RunRecord)(await response.json());
      const file = Schema.decodeUnknownSync(FileContent)(
        await (await action({ op: "filesystem.readFile", path: "/tmp/shared" })).json(),
      );
      return {
        mode,
        passed:
          uploaded.status === 200 &&
          executable.status === 200 &&
          reset.status === 200 &&
          response.status === 200 &&
          record.status === "exited" &&
          record.output?.result === 0 &&
          record.output.exitCode === 0 &&
          record.output.stdout === "parent\nchild\nwaited\n" &&
          Buffer.from(file.content, file.encoding).toString() === "abcXY",
      };
    }),
  ),
);
const closefromUploaded = await action({
  op: "filesystem.writeFile",
  path: "/tmp/child.wasm",
  content: child,
  encoding: "base64",
});
const closefromExecutable = await action({
  op: "filesystem.chmod",
  path: "/tmp/child.wasm",
  mode: 493,
});
const closefromReset = await action({
  op: "filesystem.writeFile",
  path: "/tmp/shared",
  content: "abc",
  encoding: "utf8",
});
const closefromSource = Buffer.from(
  await Bun.file(join(import.meta.dir, "../dist/wasi-child-parent-closefrom.wasm")).arrayBuffer(),
).toString("base64");
const closefromResponse = await action({
  op: "process.run",
  id: "closefrom",
  language: "wasm",
  source: closefromSource,
});
const closefrom = Schema.decodeUnknownSync(RunRecord)(await closefromResponse.json());
const disposed = await action({ op: "vm.dispose" });
const checks = {
  setup: uploaded.status === 200 && executable.status === 200 && written.status === 200,
  spawnWaitInheritance:
    response.status === 200 &&
    record.status === "exited" &&
    record.output?.result === 0 &&
    record.output.exitCode === 0,
  stdioOrder: record.output?.stdout === "parent\nchild\nwaited\n",
  persistedWrite: Buffer.from(file.content, file.encoding).toString() === "abcX",
  inheritedInodeAfterRename:
    uploadedRename.status === 200 &&
    renamed.output?.result === 0 &&
    Buffer.from(moved.content, moved.encoding).toString() === "abcX" &&
    missing.status === 404,
  childTrapIsolation: trapped.every((receipt) => receipt.passed),
  spawnClosefromPreservesParent:
    closefromUploaded.status === 200 &&
    closefromExecutable.status === 200 &&
    closefromReset.status === 200 &&
    closefromResponse.status === 200 &&
    closefrom.output?.result === 0 &&
    closefrom.output.stdout === "parent\nchild\nwaited\n",
  disposal: disposed.status === 200,
};
const report = {
  measuredAt: new Date().toISOString(),
  url: configuration.url,
  sandboxId: id,
  profile: "minutei",
  runtime: "standard Worker",
  checks,
  trapped,
  allPassed: Object.values(checks).every(Boolean),
  fullProcessParity: false,
  durableChildReceipts: false,
  packageParity: false,
};
await Bun.write(
  join(import.meta.dir, "../docs/evidence/wasi-child-production.json"),
  JSON.stringify(report, null, 2) + "\n",
);
console.log(JSON.stringify(report, null, 2));
if (!report.allPassed) process.exit(1);
