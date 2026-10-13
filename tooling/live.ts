import { Config, Effect, Redacted, Schema } from "effect";
import { join } from "node:path";
import { commandPackage } from "../tests/fixtures/package";
import {
  FileContent,
  PackagePreparation,
  SoftwareCatalog,
  FileStat,
  BatchReadResults,
  BatchWriteResults,
  DirectoryTree,
  CanonicalPath,
  NetworkResult,
  ProcessPage,
  RunRecord,
  RunSummary,
  ErrorResponse,
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
  networkHosts: ["example.com", "postman-echo.com"],
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
const python = Schema.decodeUnknownSync(RunRecord)(
  await (
    await action({
      op: "python.execute",
      id: "python",
      source:
        "print('native Python')\nawait tools.call({'op':'filesystem.writeFile','path':'/tmp/python-live','content':'Python on R2','encoding':'utf8'})\n(await tools.call({'op':'filesystem.readFile','path':'/tmp/python-live'}))['content']",
    })
  ).json(),
);
const pythonLimited = Schema.decodeUnknownSync(RunRecord)(
  await (
    await action({
      op: "python.execute",
      id: "python-limited",
      source: "import sys\nsys.settrace(None)\nwhile True:\n pass",
    })
  ).json(),
);
const pythonHealthy = Schema.decodeUnknownSync(RunRecord)(
  await (await action({ op: "python.evaluate", id: "python-healthy", expression: "6 * 7" })).json(),
);
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
const networkHead = Schema.decodeUnknownSync(NetworkResult)(
  await (await action({ op: "network.fetch", url: "https://example.com", method: "HEAD" })).json(),
);
const networkPost = Schema.decodeUnknownSync(NetworkResult)(
  await (
    await action({
      op: "network.fetch",
      url: "https://postman-echo.com/post",
      method: "POST",
      headers: { "content-type": "text/plain", "x-agent": "cirro" },
      body: { content: "cirro-http-native", encoding: "utf8" },
    })
  ).json(),
);
const postEcho = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({ data: Schema.String, headers: Schema.Record(Schema.String, Schema.String) }),
  ),
)(Buffer.from(networkPost.content, "base64").toString());
const denied = await action({ op: "network.fetch", url: "https://developers.cloudflare.com" });
const backgroundStarted = Schema.decodeUnknownSync(RunRecord)(
  await (
    await action({
      op: "process.spawn",
      execution: {
        op: "process.run",
        id: "background",
        language: "javascript",
        source:
          "export default async ({tools}) => { await tools.call({op:'network.fetch',url:'https://example.com'}); await tools.call({op:'filesystem.writeFile',path:'/tmp/background-proof',content:'continued',encoding:'utf8'}); return 42; }",
      },
    })
  ).json(),
);
const backgroundObserved = Schema.decodeUnknownSync(RunRecord)(
  await (await action({ op: "process.wait", id: "background", timeoutMs: 25_000 })).json(),
);
const backgroundContent = Schema.decodeUnknownSync(FileContent)(
  await (await action({ op: "filesystem.readFile", path: "/tmp/background-proof" })).json(),
);
const duplicateBackground = await action({
  op: "process.spawn",
  execution: { op: "process.run", id: "background", language: "shell", source: "false" },
});
const backgroundRepeated = Schema.decodeUnknownSync(RunRecord)(
  await (await action({ op: "process.wait", id: "background", timeoutMs: 0 })).json(),
);

const longStarted = Schema.decodeUnknownSync(RunRecord)(
  await (
    await action({
      op: "process.spawn",
      execution: {
        op: "process.run",
        id: "long-background",
        language: "wasm",
        source: Buffer.from(
          await Bun.file(join(import.meta.dir, "../dist/wasi-background.wasm")).arrayBuffer(),
        ).toString("base64"),
      },
    })
  ).json(),
);
const earlyLong = await action({ op: "process.wait", id: "long-background", timeoutMs: 25_000 });
const longCompleted = Schema.decodeUnknownSync(RunRecord)(
  await (await action({ op: "process.wait", id: "long-background", timeoutMs: 25_000 })).json(),
);
const repaired = await post(
  "/v1/maintenance/process-dispatch",
  Redacted.value(configuration.key),
  {},
);

const cancelledStarted = Schema.decodeUnknownSync(RunRecord)(
  await (
    await action({
      op: "process.spawn",
      execution: {
        op: "process.run",
        id: "cancel-background",
        language: "wasm",
        source: Buffer.from(
          await Bun.file(join(import.meta.dir, "../dist/wasi-background.wasm")).arrayBuffer(),
        ).toString("base64"),
      },
    })
  ).json(),
);
const observedCancellation: (typeof RunRecord.Type)[] = [];
for (const attempt of Array.from({ length: 20 }, (_, index) => index)) {
  const current = Schema.decodeUnknownSync(RunRecord)(
    await (await action({ op: "process.get", id: "cancel-background" })).json(),
  );
  if (current.status === "running") {
    observedCancellation.push(current);
    break;
  }
  await Bun.sleep(200);
}
const cancellationRequested = Schema.decodeUnknownSync(RunSummary)(
  await (await action({ op: "process.cancel", id: "cancel-background" })).json(),
);
const cancellationWait = await action({
  op: "process.wait",
  id: "cancel-background",
  timeoutMs: 10_000,
});
const cancellationError = Schema.decodeUnknownSync(ErrorResponse)(await cancellationWait.json());
const cancellationFinal = Schema.decodeUnknownSync(RunRecord)(
  await (await action({ op: "process.get", id: "cancel-background" })).json(),
);
const cancellationRepeated = Schema.decodeUnknownSync(RunSummary)(
  await (await action({ op: "process.cancel", id: "cancel-background" })).json(),
);

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
const wasiPathsSource = Buffer.from(
  await Bun.file(join(import.meta.dir, "../dist/wasi-paths.wasm")).arrayBuffer(),
).toString("base64");
const wasiPaths = Schema.decodeUnknownSync(RunRecord)(
  await (
    await action({ op: "process.run", id: "wasi-paths", language: "wasm", source: wasiPathsSource })
  ).json(),
);
const wasiPathsRemoved = await action({ op: "filesystem.readdir", path: "/tmp/paths" });
const wasiSettersSource = Buffer.from(
  await Bun.file(join(import.meta.dir, "../dist/wasi-setters.wasm")).arrayBuffer(),
).toString("base64");
const wasiSetters = Schema.decodeUnknownSync(RunRecord)(
  await (
    await action({
      op: "process.run",
      id: "wasi-setters",
      language: "wasm",
      source: wasiSettersSource,
    })
  ).json(),
);
const wasiSettersStat = Schema.decodeUnknownSync(FileStat)(
  await (await action({ op: "filesystem.stat", path: "/tmp/setters", follow: true })).json(),
);
const wasiDetachedMissing = await action({
  op: "filesystem.stat",
  path: "/tmp/setters-detached",
  follow: true,
});
const packageBytes = commandPackage(
  new Uint8Array(await Bun.file(join(import.meta.dir, "../dist/wasi-inputs.wasm")).arrayBuffer()),
);
const packageDigest = `sha256:${Buffer.from(await crypto.subtle.digest("SHA-256", packageBytes)).toString("hex")}`;
const packageWritten = await action({
  op: "filesystem.writeFile",
  path: "/tmp/probe.aospkg",
  content: packageBytes.toString("base64"),
  encoding: "base64",
});
const packageInstalledResponse = await action({
  op: "software.install",
  source: { path: "/tmp/probe.aospkg", digest: packageDigest },
});
const packageInstalled = Schema.decodeUnknownSync(PackagePreparation.fields.installed)(
  await packageInstalledResponse.json(),
);
const packageCatalog = Schema.decodeUnknownSync(SoftwareCatalog)(
  await (await action({ op: "software.list" })).json(),
);
const packageCommand = Schema.decodeUnknownSync(RunRecord)(
  await (
    await action({
      op: "process.execFile",
      id: "package-command",
      command: "probe",
      args: ["production"],
    })
  ).json(),
);
const packageProtected = await action({
  op: "filesystem.chmod",
  path: "/opt/cirro/pkgs/probe/1.0.0/bin/probe",
  mode: 0o777,
});
const packageLinked = await action({
  op: "software.link",
  packageId: packageInstalled.packageId,
  command: "probe",
  alias: "custom",
});
const packageAlias = Schema.decodeUnknownSync(RunRecord)(
  await (
    await action({
      op: "process.execFile",
      id: "package-alias",
      command: "custom",
      env: { CIRRO_MARKER: "caller" },
    })
  ).json(),
);
const packageShell = Schema.decodeUnknownSync(RunRecord)(
  await (
    await action({
      op: "process.run",
      id: "package-shell",
      language: "shell",
      source:
        "echo before > /tmp/shell-before; echo input | custom argument > /tmp/shell-output; cat /tmp/shell-before; cat /tmp/shell-output",
    })
  ).json(),
);
const packageRemoved = await action({
  op: "software.uninstall",
  packageId: packageInstalled.packageId,
});
const packageAbsent = Schema.decodeUnknownSync(SoftwareCatalog)(
  await (await action({ op: "software.installed" })).json(),
);
const packageMissingCommand = await action({
  op: "process.execFile",
  id: "removed-package",
  command: "probe",
});
const pollSource = Buffer.from(
  await Bun.file(join(import.meta.dir, "../dist/wasi-poll.wasm")).arrayBuffer(),
).toString("base64");
const pollRun = Schema.decodeUnknownSync(RunRecord)(
  await (
    await action({ op: "process.run", id: "poll", language: "wasm", source: pollSource })
  ).json(),
);
const allocated = Schema.decodeUnknownSync(FileContent)(
  await (await action({ op: "filesystem.readFile", path: "/tmp/allocated" })).json(),
);
const alive = await action({ op: "vm.status" });
const largeFileWritten = await action({
  op: "filesystem.writeFile",
  path: "/tmp/large-boundary",
  content: Buffer.alloc(16_777_216, 90).toString("base64"),
  encoding: "base64",
});
const largeFileTail = Schema.decodeUnknownSync(FileContent)(
  await (
    await action({
      op: "filesystem.readFile",
      path: "/tmp/large-boundary",
      offset: 16_777_200,
      length: 16,
    })
  ).json(),
);
const rangeWritten = await action({
  op: "filesystem.writeFile",
  path: "/tmp/range",
  offset: 262_145,
  content: "Z",
  encoding: "utf8",
});
const rangeRead = Schema.decodeUnknownSync(FileContent)(
  await (
    await action({ op: "filesystem.readFile", path: "/tmp/range", offset: 262_142, length: 4 })
  ).json(),
);
const rangePatched = await action({
  op: "filesystem.writeFile",
  path: "/tmp/range",
  offset: 262_142,
  content: "abcd",
  encoding: "utf8",
});
const rangeFinal = Schema.decodeUnknownSync(FileContent)(
  await (
    await action({ op: "filesystem.readFile", path: "/tmp/range", offset: 262_142, length: 4 })
  ).json(),
);
const hostFsPackage = await action({
  op: "software.install",
  source: { path: "/tmp/probe.aospkg" },
});
const hostFsSource = Buffer.from(
  await Bun.file(join(import.meta.dir, "../dist/wasi-host-fs.wasm")).arrayBuffer(),
).toString("base64");
const hostFs = Schema.decodeUnknownSync(RunRecord)(
  await (
    await action({ op: "process.run", id: "host-fs", language: "wasm", source: hostFsSource })
  ).json(),
);
const disposed = await action({ op: "vm.dispose" });
const afterDispose = await action({ op: "vm.status" });
const checks = {
  processCancellation:
    cancelledStarted.status === "queued" &&
    observedCancellation.length === 1 &&
    cancellationRequested.status === "cancelling" &&
    cancellationWait.status === 409 &&
    cancellationError.error === "ECANCELED" &&
    cancellationFinal.status === "cancelled" &&
    cancellationFinal.output === null,
  cancellationIdempotency:
    cancellationRepeated.status === "cancelled" &&
    cancellationRepeated.finishedAt === cancellationFinal.finishedAt,

  durableBackground:
    longStarted.status === "queued" &&
    earlyLong.status === 408 &&
    longCompleted.status === "exited" &&
    longCompleted.output?.exitCode === 0 &&
    longCompleted.output.stdout === "continued beyond the HTTP continuation\n",
  dispatchMaintenance: repaired.status === 200,

  backgroundExecution:
    backgroundStarted.status === "queued" &&
    backgroundObserved.status === "exited" &&
    backgroundObserved.output?.exitCode === 0 &&
    backgroundObserved.output.result === 42 &&
    Buffer.from(backgroundContent.content, "base64").toString() === "continued",
  backgroundObservation:
    duplicateBackground.status === 409 &&
    backgroundRepeated.finishedAt === backgroundObserved.finishedAt &&
    backgroundRepeated.output?.result === 42,

  httpRequest:
    networkPost.status === 200 &&
    postEcho.data === "cirro-http-native" &&
    postEcho.headers["x-agent"] === "cirro",
  httpHead:
    networkHead.status === 200 &&
    networkHead.content === "" &&
    typeof networkHead.headers["content-type"] === "string",
  largeFileBoundary:
    largeFileWritten.status === 200 &&
    Buffer.from(largeFileTail.content, "base64").equals(Buffer.alloc(16, 90)),
  positionalFilesystem:
    rangeWritten.status === 200 &&
    rangePatched.status === 200 &&
    Buffer.from(rangeRead.content, "base64").equals(Buffer.from([0, 0, 0, 90])) &&
    Buffer.from(rangeFinal.content, "base64").toString() === "abcd",
  wasiAllocationPoll:
    pollRun.output?.exitCode === 0 &&
    pollRun.output.stdout ===
      "allocation preserved cursor and zeros; poll preserved userdata, EOF and clocks\n" &&
    Buffer.from(allocated.content, "base64").equals(
      Buffer.concat([Buffer.from("original"), Buffer.alloc(8)]),
    ),
  softwareShell:
    packageShell.output?.exitCode === 0 &&
    packageShell.output.stdout.includes("before\n") &&
    packageShell.output.stdout.includes("marker=package") &&
    packageShell.output.stdout.includes("stdin=[105, 110, 112, 117, 116, 10]"),
  softwareInstallation:
    packageWritten.status === 200 &&
    packageInstalledResponse.status === 200 &&
    packageInstalled.digest === packageDigest &&
    packageCatalog.length === 1,
  softwareExecution:
    packageCommand.output?.exitCode === 0 &&
    packageCommand.output.stdout.includes("marker=package") &&
    packageCommand.output.stdout.includes("production"),
  softwareProtection: packageProtected.status === 403,
  softwareAliases:
    packageLinked.status === 200 &&
    packageAlias.output?.exitCode === 0 &&
    packageAlias.output.stdout.includes("marker=caller"),
  softwareRemoval:
    packageRemoved.status === 200 &&
    packageAbsent.length === 0 &&
    packageMissingCommand.status === 404,

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
  wasiSetters:
    wasiSetters.output?.exitCode === 0 &&
    wasiSetters.output.stdout ===
      "setters preserved offsets, zeros, precise times and detached inodes\n" &&
    wasiSettersStat.atimeNs === "18446744073709551615" &&
    wasiSettersStat.mtimeNs === "9007199254740995" &&
    wasiSettersStat.size === 8 &&
    wasiDetachedMissing.status === 404,
  wasiPaths:
    wasiPaths.output?.exitCode === 0 &&
    wasiPaths.output.stdout ===
      'link=source\nnames=["link", "source", "target"]\nold=target bytes\ncurrent=updatedbytes\nmissing=true\npaths removed\n' &&
    wasiPathsRemoved.status === 404,
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
  python:
    python.output?.exitCode === 0 &&
    python.output.stdout === "native Python\n" &&
    python.output.result === Buffer.from("Python on R2").toString("base64"),
  pythonLimits: pythonLimited.status === "failed" && pythonHealthy.output?.result === 42,
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
  hostFilesystem:
    hostFsPackage.status === 200 &&
    hostFs.output?.exitCode === 0 &&
    hostFs.output.stdout === "creation modes and detached temporary file passed\n",
  disposal: disposed.status === 200 && afterDispose.status === 404,
};
const report = {
  measuredAt: new Date().toISOString(),
  url: configuration.url,
  profile: "minutei",
  runtime: "standard-worker-rust-quickjs-wasmi-rustpython",
  parityComplete: false,
  scope: "Implemented operations, native Python, isolation and resource limits",
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
