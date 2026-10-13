import { Config, Effect, Redacted, Schema } from "effect";
import { join } from "node:path";
import {
  FileContent,
  BatchReadResults,
  BatchWriteResults,
  DirectoryTree,
  CanonicalPath,
  NetworkResult,
  ProcessPage,
  RunRecord,
  Status,
  TokenResponse,
} from "../src/contracts";

const configuration = await Effect.runPromise(
  Effect.gen(function* () {
    const key = yield* Config.Redacted("CIRRO_API_KEY");
    const url = yield* Config.String("CIRRO_URL");
    return { key, url };
  }),
);
const id = `proof-${crypto.randomUUID()}`;
const policy = {
  networkHosts: ["example.com"],
  interruptBudget: 1000,
  memoryBytes: 8_388_608,
  maxOutputBytes: 1_048_576,
};
const post = (path: string, credential: string, body: unknown) =>
  fetch(new URL(path, configuration.url), {
    method: "POST",
    headers: { authorization: `Bearer ${credential}`, "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(60_000),
  });
const health = await fetch(new URL("/health", configuration.url));
const created = await post("/v1/sandboxes", Redacted.value(configuration.key), { id, policy });
const minted = await post(`/v1/sandboxes/${id}/capabilities`, Redacted.value(configuration.key), {
  permissions: ["read", "write", "execute", "network", "manage"],
  expiresInSeconds: 3600,
});
const token = Schema.decodeUnknownSync(TokenResponse)(await minted.json()).token;
const action = (input: unknown) => post(`/v1/sandboxes/${id}/action`, token, input);
const write = await action({
  op: "filesystem.writeFile",
  path: "/tmp/from-client",
  content: "R2 native",
  encoding: "utf8",
});
const read = Schema.decodeUnknownSync(FileContent)(
  await (await action({ op: "filesystem.readFile", path: "/tmp/from-client" })).json(),
);
const js = Schema.decodeUnknownSync(RunRecord)(
  await (
    await action({
      op: "process.run",
      id: "js",
      language: "javascript",
      source:
        "export default async ({tools, console}) => { await tools.call({op:'filesystem.writeFile',path:'/tmp/from-guest',content:'guest persisted',encoding:'utf8'}); console.log('native isolate'); return 42; };",
    })
  ).json(),
);
const guestFile = Schema.decodeUnknownSync(FileContent)(
  await (await action({ op: "filesystem.readFile", path: "/tmp/from-guest" })).json(),
);
const shell = Schema.decodeUnknownSync(RunRecord)(
  await (
    await action({
      op: "process.run",
      id: "shell",
      language: "shell",
      source: "echo 'R2 shell' > /tmp/shell; cat /tmp/shell | grep '^R2'",
    })
  ).json(),
);
const typescript = Schema.decodeUnknownSync(RunRecord)(
  await (
    await action({
      op: "process.run",
      id: "typescript",
      language: "typescript",
      source:
        "interface Answer { value: number }; enum Choice { First, Second }; export default (): Answer => ({value:41+Choice.Second});",
    })
  ).json(),
);
const python = await action({
  op: "process.run",
  id: "python",
  language: "python",
  source: "async def main(tools):\n    return 42\n",
});
const wasm = await Bun.file(join(import.meta.dir, "../dist/guest-test.wasm")).arrayBuffer();
const rust = Schema.decodeUnknownSync(RunRecord)(
  await (
    await action({
      op: "process.run",
      id: "rust",
      language: "wasm",
      source: Buffer.from(wasm).toString("base64"),
    })
  ).json(),
);
const network = Schema.decodeUnknownSync(NetworkResult)(
  await (await action({ op: "network.fetch", url: "https://example.com" })).json(),
);
const denied = await action({ op: "network.fetch", url: "https://developers.cloudflare.com" });
const page = Schema.decodeUnknownSync(ProcessPage)(
  await (await action({ op: "process.list", limit: 2, cursor: null })).json(),
);
const status = Schema.decodeUnknownSync(Status)(await (await action({ op: "vm.status" })).json());
const cpu = Schema.decodeUnknownSync(RunRecord)(
  await (
    await action({
      op: "process.run",
      id: "cpu",
      language: "javascript",
      source: "export default () => { while (true) {} };",
    })
  ).json(),
);
const memory = Schema.decodeUnknownSync(RunRecord)(
  await (
    await action({
      op: "process.run",
      id: "memory",
      language: "javascript",
      source: "export default () => Array(10000000).fill('memory');",
    })
  ).json(),
);
const platformImport = await action({
  op: "process.run",
  id: "platform-import",
  language: "javascript",
  source: "import {env} from 'cloudflare:workers'; export default () => env;",
});
const moduleWrite = await action({
  op: "filesystem.writeFile",
  path: "/tmp/answer.ts",
  content: "export const answer: number=42;",
  encoding: "utf8",
});
const entryWrite = await action({
  op: "filesystem.writeFile",
  path: "/tmp/main.ts",
  content:
    "import {answer} from './answer.ts'; console.log('module',answer); await tools.call({op:'filesystem.writeFile',path:'/tmp/module-result',content:String(answer),encoding:'utf8'});",
  encoding: "utf8",
});
const moduleRun = Schema.decodeUnknownSync(RunRecord)(
  await (await action({ op: "typescript.executeFile", id: "module", path: "/tmp/main.ts" })).json(),
);
const expression = Schema.decodeUnknownSync(RunRecord)(
  await (
    await action({ op: "typescript.evaluate", id: "expression", expression: "(40 as number)+2" })
  ).json(),
);
const script = Schema.decodeUnknownSync(RunRecord)(
  await (
    await action({
      op: "javascript.execute",
      id: "script",
      source: "console.log('script without default export');",
    })
  ).json(),
);
const guestFault = Schema.decodeUnknownSync(RunRecord)(
  await (
    await action({
      op: "javascript.evaluate",
      id: "fault",
      expression: "tools.call({op:'filesystem.readFile',path:'/missing'}).catch(error=>error.code)",
    })
  ).json(),
);
const compilerDeep = await action({
  op: "javascript.evaluate",
  id: "deep-first",
  expression: "(".repeat(10000) + "42" + ")".repeat(10000),
});
const compilerDeepAgain = await action({
  op: "javascript.evaluate",
  id: "deep-second",
  expression: "(".repeat(10000) + "42" + ")".repeat(10000),
});
const compilerRecovered = Schema.decodeUnknownSync(RunRecord)(
  await (
    await action({
      op: "typescript.evaluate",
      id: "compiler-recovered",
      expression: "(40 as number)+2",
    })
  ).json(),
);
const lazy = Schema.decodeUnknownSync(RunRecord)(
  await (
    await action({
      op: "javascript.execute",
      id: "lazy",
      source:
        "const path='/tmp/lazy.ts'; await tools.call({op:'filesystem.writeFile',path,content:'export function answer(): number {return 42;}',encoding:'utf8'}); const [a,b]=await Promise.all([import(path),import(path)]); console.log(a.answer(),a===b); await tools.call({op:'filesystem.writeFile',path,content:'export function answer(): number {return 99;}',encoding:'utf8'}); console.log((await import(path)).answer());",
    })
  ).json(),
);
const lazyFailure = Schema.decodeUnknownSync(RunRecord)(
  await (
    await action({
      op: "javascript.evaluate",
      id: "lazy-failure",
      expression: "import('/tmp/absent.mjs').catch(error=>error.code)",
    })
  ).json(),
);
const batchWrite = Schema.decodeUnknownSync(BatchWriteResults)(
  await (
    await action({
      op: "filesystem.writeFiles",
      entries: [
        { path: "/tmp/batch/deep/a", content: "batch", encoding: "utf8" },
        { path: "/tmp/batch/deep/a", content: "%%%", encoding: "base64" },
        { path: "/tmp/batch/skip/b", content: "excluded", encoding: "utf8" },
      ],
    })
  ).json(),
);
const batchRead = Schema.decodeUnknownSync(BatchReadResults)(
  await (
    await action({ op: "filesystem.readFiles", paths: ["/tmp/batch/deep/a", "/missing"] })
  ).json(),
);
const batchTree = Schema.decodeUnknownSync(DirectoryTree)(
  await (
    await action({ op: "filesystem.readdirRecursive", path: "/tmp/batch", exclude: ["skip"] })
  ).json(),
);
const batchLink = await action({
  op: "filesystem.symlink",
  path: "/tmp/batch-alias",
  target: "batch/deep/a",
});
const batchPath = Schema.decodeUnknownSync(CanonicalPath)(
  await (await action({ op: "filesystem.realpath", path: "/tmp/batch-alias" })).json(),
);
const wasiSource = Buffer.from(
  await Bun.file(join(import.meta.dir, "../dist/wasi-test.wasm")).arrayBuffer(),
).toString("base64");
const wasiRun = Schema.decodeUnknownSync(RunRecord)(
  await (
    await action({ op: "process.run", id: "wasi", language: "wasm", source: wasiSource })
  ).json(),
);
const wasiFile = Schema.decodeUnknownSync(FileContent)(
  await (await action({ op: "filesystem.readFile", path: "/tmp/wasi-file" })).json(),
);
const wasiInvalidPointer = Schema.decodeUnknownSync(RunRecord)(
  await (
    await action({
      op: "process.run",
      id: "wasi-pointer",
      language: "wasm",
      source: Buffer.from(
        await Bun.file(join(import.meta.dir, "../dist/wasi-bad-pointer.wasm")).arrayBuffer(),
      ).toString("base64"),
    })
  ).json(),
);
const wasiRandom = Schema.decodeUnknownSync(RunRecord)(
  await (
    await action({
      op: "process.run",
      id: "wasi-random",
      language: "wasm",
      source: Buffer.from(
        await Bun.file(join(import.meta.dir, "../dist/wasi-clock-random.wasm")).arrayBuffer(),
      ).toString("base64"),
    })
  ).json(),
);
const wasiTrap = Schema.decodeUnknownSync(RunRecord)(
  await (
    await action({
      op: "process.run",
      id: "wasi-trap",
      language: "wasm",
      source: Buffer.from(
        await Bun.file(join(import.meta.dir, "../dist/wasi-trap.wasm")).arrayBuffer(),
      ).toString("base64"),
    })
  ).json(),
);
const wasiUncommitted = await action({ op: "filesystem.readFile", path: "/tmp/from-abi" });
const wasiSyncedTrap = Schema.decodeUnknownSync(RunRecord)(
  await (
    await action({
      op: "process.run",
      id: "wasi-synced-trap",
      language: "wasm",
      source: Buffer.from(
        await Bun.file(join(import.meta.dir, "../dist/wasi-synced-trap.wasm")).arrayBuffer(),
      ).toString("base64"),
    })
  ).json(),
);
const wasiCheckpoint = Schema.decodeUnknownSync(FileContent)(
  await (await action({ op: "filesystem.readFile", path: "/tmp/from-abi" })).json(),
);
const wasiInputsSource = Buffer.from(
  await Bun.file(join(import.meta.dir, "../dist/wasi-inputs.wasm")).arrayBuffer(),
).toString("base64");
const wasiInputs = Schema.decodeUnknownSync(RunRecord)(
  await (
    await action({
      op: "process.run",
      id: "wasi-inputs",
      language: "wasm",
      source: wasiInputsSource,
      args: ["ação"],
      env: { CIRRO_MARKER: "supplied" },
      stdin: { content: "AP8K", encoding: "base64" },
    })
  ).json(),
);
const wasiInputsFile = await action({
  op: "filesystem.writeFile",
  path: "/tmp/inputs.wasm",
  content: wasiInputsSource,
  encoding: "base64",
});
const wasiFromFile = Schema.decodeUnknownSync(RunRecord)(
  await (
    await action({
      op: "wasm.executeFile",
      id: "wasi-file",
      path: "/tmp/inputs.wasm",
      args: ["file"],
      stdin: { content: "fala", encoding: "utf8" },
    })
  ).json(),
);
const alive = await action({ op: "vm.status" });
const disposed = await action({ op: "vm.dispose" });
const afterDispose = await action({ op: "vm.status" });
const checks = {
  batchPartialSuccess:
    batchWrite.length === 3 &&
    batchWrite[0]?.success === true &&
    batchWrite[1]?.success === false &&
    batchWrite[2]?.success === true,
  batchRead:
    batchRead[0]?.content === Buffer.from("batch").toString("base64") &&
    batchRead[1]?.content === null,
  recursiveListing:
    batchTree.map((entry) => entry.path).join(",") === "/tmp/batch/deep,/tmp/batch/deep/a",
  canonicalPath: batchLink.status === 200 && batchPath.path === "/tmp/batch/deep/a",
  wasiFileAndSync:
    wasiRun.output?.exitCode === 0 &&
    wasiRun.output.stdout === "persistent WASI\n" &&
    Buffer.from(wasiFile.content, "base64").toString() === "persistent WASI",
  wasiInvalidPointer: wasiInvalidPointer.output?.result === 21,
  wasiClockAndRandom: wasiRandom.output?.result === 42,
  wasiUncommittedTrap: wasiTrap.status === "failed" && wasiUncommitted.status === 404,
  wasiCheckpoint:
    wasiSyncedTrap.status === "failed" &&
    Buffer.from(wasiCheckpoint.content, "base64").toString() === "before trap",
  wasiInputs:
    wasiInputs.output?.stdout.includes('argv=["/tmp/__cirro_inline__.wasm", "ação"]') === true &&
    wasiInputs.output.stdout.includes("marker=supplied") &&
    wasiInputs.output.stdout.includes("private=unset") &&
    wasiInputs.output.stdout.includes("stdin=[0, 255, 10]") &&
    wasiInputs.output.stdout.includes("eof=0"),
  wasiExecuteFile:
    wasiInputsFile.status === 200 &&
    wasiFromFile.output?.stdout.includes('argv=["/tmp/inputs.wasm", "file"]') === true &&
    wasiFromFile.output.stdout.includes("stdin=[102, 97, 108, 97]"),
  health: health.status === 200,
  created: created.status === 201,
  r2RoundTrip:
    write.status === 200 && Buffer.from(read.content, "base64").toString() === "R2 native",
  javascript:
    js.status === "exited" && js.output?.result === 42 && js.output.stdout === "native isolate\n",
  guestPersistence: Buffer.from(guestFile.content, "base64").toString() === "guest persisted",
  shell: shell.status === "exited" && shell.output?.stdout === "R2 shell\n",
  typescript:
    typescript.status === "exited" &&
    Schema.is(Schema.Struct({ value: Schema.Literal(42) }))(typescript.output?.result),
  pythonExplicitlyUnavailable: python.status === 501,
  rust: rust.status === "exited" && rust.output?.result === 42,
  authorizedNetwork: network.status === 200,
  deniedNetwork: denied.status === 403,
  pagination: page.items.length === 2 && page.cursor !== null,
  filesystemStatus: status.filesystemBytes > 0,
  executionBudgetEnforcement: cpu.status === "failed" && alive.status === 200,
  memoryEnforcement:
    memory.output?.exitCode === 1 && memory.output.stderr.includes("out of memory"),
  platformImportsDenied: platformImport.status === 422,
  sandboxModuleExecution:
    moduleWrite.status === 200 &&
    entryWrite.status === 200 &&
    moduleRun.output?.stdout === "module 42\n",
  expressionEvaluation: expression.output?.result === 42,
  scriptExecution: script.output?.stdout === "script without default export\n",
  guestFaultCodes: guestFault.output?.result === "ENOENT",
  compilerRecovery:
    compilerDeep.status === 422 &&
    compilerDeepAgain.status === 422 &&
    compilerRecovered.output?.result === 42,
  lazyModuleExecution: lazy.output?.stdout === "42 true\n42\n",
  lazyModuleFailure: lazyFailure.output?.result === "MODULE_NOT_FOUND",
  disposal: disposed.status === 200 && afterDispose.status === 404,
};
const report = {
  measuredAt: new Date().toISOString(),
  url: configuration.url,
  profile: "minutei",
  runtime: "standard-worker-rust-quickjs-wasmi",
  parityComplete: false,
  scope: "Implemented operations and explicit Python rejection",
  sandboxId: id,
  checks,
  allPassed: Object.values(checks).every(Boolean),
};
await Bun.write(
  join(import.meta.dir, "../docs/evidence/production.json"),
  JSON.stringify(report, null, 2) + "\n",
);
console.log(JSON.stringify(report, null, 2));
if (!report.allPassed) process.exit(1);
