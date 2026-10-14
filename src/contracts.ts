import wasmModuleBytes from "./wasm-module-bytes.json";
import { Schema, Struct } from "effect";

export const Id = Schema.String.check(Schema.isPattern(/^[a-zA-Z0-9_-]{1,64}$/));
export const Path = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4096));
export const ContentEncoding = Schema.Literals(["utf8", "base64"]);
export const Content = Schema.String.check(Schema.isMaxLength(22_369_624));
export const Permission = Schema.Literals(["read", "write", "execute", "network", "manage"]);
export const Policy = Schema.Struct({
  networkHosts: Schema.Array(Schema.String.check(Schema.isPattern(/^[a-z0-9.-]{1,253}$/))).check(
    Schema.isMaxLength(32),
  ),
  interruptBudget: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 100_000 })),
  memoryBytes: Schema.Int.check(Schema.isBetween({ minimum: 4_194_304, maximum: 33_554_432 })),
  maxOutputBytes: Schema.Int.check(Schema.isBetween({ minimum: 1024, maximum: 1_048_576 })),
});
export const PolicyPatch = Policy.mapFields((fields) => Struct.map(fields, Schema.optionalKey));
export const CreateSandbox = Schema.Struct({ id: Id, policy: Policy });
export const Capability = Schema.Struct({
  sandboxId: Id,
  expiresAt: Schema.Int,
  permissions: Schema.Array(Permission).check(Schema.isMinLength(1), Schema.isMaxLength(5)),
});
export const MintCapability = Schema.Struct({
  expiresInSeconds: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 86_400 })),
  permissions: Schema.Array(Permission).check(Schema.isMinLength(1), Schema.isMaxLength(5)),
});
export const Head = Schema.Struct({
  version: Schema.Literal(2),
  manifest: Schema.String.check(Schema.isMaxLength(8_388_608)),
  policy: Policy,
  createdAt: Schema.Int,
  deleted: Schema.Boolean,
});

export const DirectoryExclusions = Schema.Array(
  Schema.String.check(Schema.isPattern(/^[^/\0]{1,255}$/)),
).check(Schema.isMaxLength(128));

export const FilesystemAction = Schema.Union([
  Schema.Struct({
    op: Schema.Literal("filesystem.readFiles"),
    paths: Schema.Array(Path).check(Schema.isMaxLength(128)),
  }),
  Schema.Struct({
    op: Schema.Literal("filesystem.writeFiles"),
    entries: Schema.Array(
      Schema.Struct({
        path: Path,
        content: Content,
        encoding: ContentEncoding,
      }),
    ).check(Schema.isMaxLength(128)),
  }),
  Schema.Struct({
    op: Schema.Literal("filesystem.readdirRecursive"),
    path: Path,
    maxDepth: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 64 }))),
    exclude: Schema.optionalKey(DirectoryExclusions),
  }),
  Schema.Struct({ op: Schema.Literal("filesystem.realpath"), path: Path }),
  Schema.Struct({
    op: Schema.Literal("filesystem.readFile"),
    path: Path,
    offset: Schema.optionalKey(
      Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER })),
    ),
    length: Schema.optionalKey(
      Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 16_777_216 })),
    ),
  }),
  Schema.Struct({
    op: Schema.Literal("filesystem.writeFile"),
    path: Path,
    offset: Schema.optionalKey(
      Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER })),
    ),
    content: Content,
    encoding: ContentEncoding,
  }),
  Schema.Struct({ op: Schema.Literal("filesystem.appendFile"), path: Path, content: Content }),
  Schema.Struct({ op: Schema.Literal("filesystem.stat"), path: Path, follow: Schema.Boolean }),
  Schema.Struct({ op: Schema.Literal("filesystem.exists"), path: Path }),
  Schema.Struct({ op: Schema.Literal("filesystem.mkdir"), path: Path, recursive: Schema.Boolean }),
  Schema.Struct({ op: Schema.Literal("filesystem.readdir"), path: Path }),
  Schema.Struct({ op: Schema.Literal("filesystem.move"), from: Path, to: Path }),
  Schema.Struct({ op: Schema.Literal("filesystem.remove"), path: Path, recursive: Schema.Boolean }),
  Schema.Struct({ op: Schema.Literal("filesystem.symlink"), path: Path, target: Path }),
  Schema.Struct({ op: Schema.Literal("filesystem.readlink"), path: Path }),
  Schema.Struct({
    op: Schema.Literal("filesystem.chmod"),
    path: Path,
    mode: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 511 })),
  }),
  Schema.Struct({
    op: Schema.Literal("filesystem.truncate"),
    path: Path,
    size: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 16_777_216 })),
  }),
]);
export const NetworkHeaders = Schema.Record(
  Schema.String.check(Schema.isPattern(/^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,256}$/)),
  Schema.String.check(Schema.isMaxLength(8192), Schema.isPattern(/^[\t\x20-\x7e\x80-\xff]*$/)),
);
export const NetworkRequest = Schema.Struct({
  method: Schema.optionalKey(
    Schema.Literals(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]),
  ),
  headers: Schema.optionalKey(NetworkHeaders),
  body: Schema.optionalKey(
    Schema.Struct({
      content: Schema.String.check(Schema.isMaxLength(1_398_104)),
      encoding: ContentEncoding,
    }),
  ),
});
export const NetworkAction = NetworkRequest.mapFields((fields) => ({
  ...fields,
  op: Schema.Literal("network.fetch"),
  url: Schema.String.check(Schema.isMaxLength(8192)),
}));
export const ProcessListAction = Schema.Struct({
  op: Schema.Literal("process.list"),
  limit: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 50 })),
  cursor: Schema.NullOr(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4096))),
});
export const ProcessWaitAction = Schema.Struct({
  op: Schema.Literal("process.wait"),
  id: Id,
  timeoutMs: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 25_000 })),
});
export const ProcessCancelAction = Schema.Struct({ op: Schema.Literal("process.cancel"), id: Id });
export const ProcessOutputAction = Schema.Struct({
  op: Schema.Literal("process.output.read"),
  id: Id,
  after: Schema.NullOr(Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 2_097_152 }))),
  maxBytes: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 65_536 })),
  maxEvents: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 128 })),
});
export const LiveOutputCursor = Schema.Struct({
  stdout: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 2_097_152 })),
  stderr: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 2_097_152 })),
});
export const ProcessLiveOutputAction = Schema.Struct({
  op: Schema.Literal("process.output.readLive"),
  id: Id,
  after: Schema.NullOr(LiveOutputCursor),
  maxBytes: ProcessOutputAction.fields.maxBytes,
  maxEvents: ProcessOutputAction.fields.maxEvents,
});
export const ProcessReadAction = Schema.Union([
  ProcessLiveOutputAction,
  ProcessOutputAction,
  ProcessWaitAction,
  Schema.Struct({ op: Schema.Literal("process.get"), id: Id }),
  ProcessListAction,
]);
export const Digest = Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/));
export const SourceDigest = Schema.String.check(Schema.isPattern(/^sha256:[0-9a-f]{64}$/));
export const CommandName = Schema.String.check(Schema.isPattern(/^[a-zA-Z0-9_+.-]{1,128}$/));
export const SoftwareAction = Schema.Union([
  Schema.Struct({
    op: Schema.Literal("software.install"),
    source: Schema.Union([
      Schema.Struct({ path: Path, digest: Schema.optionalKey(SourceDigest) }),
      Schema.Struct({
        url: Schema.String.check(Schema.isMaxLength(8192)),
        digest: Schema.optionalKey(SourceDigest),
      }),
    ]),
  }),
  Schema.Struct({ op: Schema.Literal("software.list") }),
  Schema.Struct({ op: Schema.Literal("software.installed") }),
  Schema.Struct({ op: Schema.Literal("software.uninstall"), packageId: Digest }),
  Schema.Struct({
    op: Schema.Literal("software.link"),
    packageId: Digest,
    command: CommandName,
    alias: Schema.optionalKey(CommandName),
  }),
]);
const InlineRun = Schema.Struct({
  op: Schema.Literal("process.run"),
  id: Id,
  language: Schema.Literals(["javascript", "typescript", "python", "shell"]),
  source: Schema.String.check(Schema.isMaxLength(1_048_576)),
});
const ScriptSource = Schema.String.check(Schema.isMaxLength(1_048_576));
const WasmSource = Schema.String.check(Schema.isMaxLength(Math.ceil(wasmModuleBytes / 3) * 4));
export const WasmConfiguration = Schema.Struct({
  argv: Schema.Array(
    Schema.String.check(Schema.isMaxLength(4096), Schema.isPattern(/^[^\0]*$/)),
  ).check(Schema.isMaxLength(129)),
  env: Schema.Record(
    Schema.String.check(Schema.isPattern(/^[^=\0]{1,128}$/)),
    Schema.String.check(Schema.isMaxLength(4096), Schema.isPattern(/^[^\0]*$/)),
  ).check(Schema.isMaxProperties(128)),
  stdin: Schema.String.check(
    Schema.isMaxLength(1_398_104),
    Schema.isPattern(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/),
  ),
});
const WasmOptions = {
  args: Schema.optionalKey(WasmConfiguration.fields.argv.check(Schema.isMaxLength(128))),
  env: Schema.optionalKey(WasmConfiguration.fields.env),
  stdin: Schema.optionalKey(
    Schema.Struct({
      content: Schema.String.check(Schema.isMaxLength(1_398_104)),
      encoding: ContentEncoding,
    }),
  ),
};
export const WasmProgram = Schema.Struct({
  language: Schema.Literal("wasm"),
  source: WasmSource,
  ...WasmConfiguration.fields,
});
export const PythonAction = Schema.Union([
  Schema.Struct({
    op: Schema.Literal("python.execute"),
    id: Id,
    source: ScriptSource,
    filePath: Schema.optionalKey(Path),
  }),
  Schema.Struct({
    op: Schema.Literal("python.evaluate"),
    id: Id,
    expression: ScriptSource,
    filePath: Schema.optionalKey(Path),
  }),
  Schema.Struct({ op: Schema.Literal("python.executeFile"), id: Id, path: Path }),
]);
export const PythonProgram = Schema.Struct({
  language: Schema.Literal("python"),
  source: ScriptSource,
  filePath: Path,
  mode: Schema.Literals(["execute", "evaluate"]),
});
export const RunAction = Schema.Union([
  InlineRun,
  PythonAction,
  Schema.Struct({
    op: Schema.Literal("process.run"),
    id: Id,
    language: Schema.Literal("wasm"),
    source: WasmSource,
    ...WasmOptions,
  }),
  Schema.Struct({ op: Schema.Literal("wasm.executeFile"), id: Id, path: Path, ...WasmOptions }),
  Schema.Struct({ op: Schema.Literal("process.execFile"), id: Id, command: Path, ...WasmOptions }),
  Schema.Struct({
    op: Schema.Literals(["javascript.execute", "typescript.execute"]),
    id: Id,
    source: ScriptSource,
    filePath: Schema.optionalKey(Path),
  }),
  Schema.Struct({
    op: Schema.Literals(["javascript.evaluate", "typescript.evaluate"]),
    id: Id,
    expression: ScriptSource,
    filePath: Schema.optionalKey(Path),
  }),
  Schema.Struct({
    op: Schema.Literals(["javascript.executeFile", "typescript.executeFile"]),
    id: Id,
    path: Path,
  }),
]);
export const SpawnAction = Schema.Struct({
  op: Schema.Literal("process.spawn"),
  execution: RunAction,
});
export const GuestAction = Schema.Union([
  SpawnAction,
  FilesystemAction,
  NetworkAction,
  ProcessReadAction,
  ProcessCancelAction,
  SoftwareAction,
]);
export const ModuleImports = Schema.Array(Schema.String.check(Schema.isMaxLength(4096))).check(
  Schema.isMaxLength(128),
);
export const ModuleCompilation = Schema.Struct({ source: ScriptSource, imports: ModuleImports });
export const ModuleRequest = Schema.Struct({
  base: Path,
  specifier: Path,
  known: Schema.Array(Path).check(Schema.isMaxLength(128)),
});
export const ModuleSource = Schema.Struct({
  name: Path,
  source: ScriptSource,
  imports: Schema.Array(Schema.Struct({ specifier: Path, target: Path })).check(
    Schema.isMaxLength(128),
  ),
});
export const ScriptProgram = Schema.Struct({
  language: Schema.Literals(["javascript", "typescript"]),
  entry: Path,
  mode: Schema.Literals(["function", "module", "evaluate"]),
  modules: Schema.Array(ModuleSource).check(Schema.isMinLength(1), Schema.isMaxLength(128)),
});
export const ModuleBatch = Schema.Struct({
  entry: Path,
  modules: Schema.Array(ModuleSource).check(Schema.isMaxLength(128)),
});
export const Program = Schema.Union([
  ScriptProgram,
  WasmProgram,
  PythonProgram,
  Schema.Struct({ language: Schema.Literal("shell"), source: ScriptSource }),
]);
export const Action = Schema.Union([
  GuestAction,
  RunAction,
  Schema.Struct({ op: Schema.Literal("config.get") }),
  Schema.Struct({ op: Schema.Literal("config.set"), policy: Policy }),
  Schema.Struct({ op: Schema.Literal("config.patch"), policy: PolicyPatch }),
  Schema.Struct({ op: Schema.Literal("vm.status") }),
  Schema.Struct({ op: Schema.Literal("vm.dispose") }),
]);
export const FileStat = Schema.Struct({
  path: Path,
  kind: Schema.Literals(["file", "directory", "symlink"]),
  size: Schema.Int,
  mode: Schema.Int,
  inode: Schema.Int,
  nlink: Schema.Int,
  uid: Schema.Int,
  gid: Schema.Int,
  atimeNs: Schema.String.check(Schema.isPattern(/^\d+$/)),
  mtimeNs: Schema.String.check(Schema.isPattern(/^\d+$/)),
  ctimeNs: Schema.String.check(Schema.isPattern(/^\d+$/)),
});
export const DirectoryEntries = Schema.Array(
  Schema.Struct({
    name: Schema.String,
    kind: Schema.Literals(["file", "directory", "symlink"]),
    inode: Schema.Int,
  }),
);
export const Chunks = Schema.Array(Digest);
export const ContentBlock = Schema.Struct({
  hash: Digest,
  size: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 262_144 })),
});
export const ReadPlan = Schema.Struct({
  blocks: Schema.Array(ContentBlock).check(Schema.isMaxLength(64)),
  skip: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 262_143 })),
  length: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 16_777_216 })),
});
export const RangeWritePlan = Schema.Struct({
  path: Path,
  size: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 16_777_216 })),
  changed: Schema.Boolean,
  chunks: Schema.Array(Schema.NullOr(Digest)).check(Schema.isMaxLength(64)),
  blocks: Schema.Array(
    Schema.Struct({
      index: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 63 })),
      size: ContentBlock.fields.size,
      previous: Schema.NullOr(ContentBlock),
    }),
  ).check(Schema.isMaxLength(64)),
});

export const RunResult = Schema.Struct({
  stdout: Schema.String,
  stderr: Schema.String,
  result: Schema.Unknown,
  exitCode: Schema.Int,
});
export const CapturedStdio = RunResult.mapFields((fields) =>
  Struct.pick(fields, ["stdout", "stderr"]),
);
export const ObservedOutput = RunResult.mapFields((fields) => ({
  ...fields,
  exitCode: Schema.NullOr(fields.exitCode),
}));
export const ToolStep = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("request"), action: Schema.fromJsonString(GuestAction) }),
  Schema.Struct({ kind: Schema.Literal("done"), output: Schema.fromJsonString(RunResult) }),
]);

export const WasmStep = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("spawn"),
    path: Path,
    argv: WasmConfiguration.fields.argv,
    env: WasmConfiguration.fields.env,
  }),
  Schema.Struct({
    kind: Schema.Literal("wait"),
    pids: Schema.Array(
      Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 4294967295 })),
    ).check(Schema.isMinLength(1), Schema.isMaxLength(8)),
  }),
  Schema.Struct({
    kind: Schema.Literal("yield"),
    fuelUsed: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 100_000_000 })),
  }),
  Schema.Struct({
    kind: Schema.Literal("open"),
    path: Path,
    base: Path,
    read: Schema.Boolean,
    write: Schema.Boolean,
    create: Schema.Boolean,
    truncate: Schema.Boolean,
    exclusive: Schema.Boolean,
    directory: Schema.Boolean,
    follow: Schema.Boolean,
    mode: Schema.Int,
  }),
  Schema.Struct({
    kind: Schema.Literal("tmpfile"),
    path: Path,
    base: Path,
    read: Schema.Boolean,
    mode: Schema.Int,
  }),
  Schema.Struct({ kind: Schema.Literal("flush"), path: Schema.NullOr(Path), fd: Schema.Int }),
  Schema.Struct({
    kind: Schema.Literal("fdStat"),
    fd: Schema.Int,
    path: Schema.NullOr(Path),
    write: Schema.Boolean,
  }),
  Schema.Struct({
    kind: Schema.Literal("fdTimes"),
    fd: Schema.Int,
    path: Schema.NullOr(Path),
    atime: Schema.String.check(Schema.isPattern(/^[0-9]+$/)),
    mtime: Schema.String.check(Schema.isPattern(/^[0-9]+$/)),
    flags: Schema.Int,
  }),
  Schema.Struct({
    kind: Schema.Literal("pathTimes"),
    path: Path,
    base: Path,
    follow: Schema.Boolean,
    atime: Schema.String.check(Schema.isPattern(/^[0-9]+$/)),
    mtime: Schema.String.check(Schema.isPattern(/^[0-9]+$/)),
    flags: Schema.Int,
  }),
  Schema.Struct({
    kind: Schema.Literal("pathStat"),
    path: Path,
    base: Path,
    follow: Schema.Boolean,
  }),
  Schema.Struct({ kind: Schema.Literal("directory"), path: Path, fd: Schema.Int }),
  Schema.Struct({ kind: Schema.Literal("mkdir"), path: Path, base: Path }),
  Schema.Struct({
    kind: Schema.Literal("remove"),
    path: Path,
    base: Path,
    directory: Schema.Boolean,
  }),
  Schema.Struct({
    kind: Schema.Literal("rename"),
    from: Path,
    fromBase: Path,
    to: Path,
    toBase: Path,
  }),
  Schema.Struct({ kind: Schema.Literal("symlink"), path: Path, base: Path, target: Path }),
  Schema.Struct({ kind: Schema.Literal("readlink"), path: Path, base: Path }),
  Schema.Struct({
    kind: Schema.Literal("poll"),
    immediate: Schema.Boolean,
    clocks: Schema.Array(
      Schema.Struct({
        index: Schema.Int,
        clock: Schema.Int,
        timeout: Schema.String.check(Schema.isPattern(/^[0-9]+$/)),
        precision: Schema.String.check(Schema.isPattern(/^[0-9]+$/)),
        absolute: Schema.Boolean,
      }),
    ).check(Schema.isMaxLength(128)),
  }),
  Schema.Struct({ kind: Schema.Literal("sync") }),
  Schema.Struct({
    kind: Schema.Literal("random"),
    length: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 65536 })),
  }),
  Schema.Struct({ kind: Schema.Literal("clock"), clock: Schema.Literals([0, 1]) }),
  Schema.Struct({ kind: Schema.Literal("done"), output: RunResult }),
]);
export const RunRecord = Schema.Struct({
  id: Id,
  status: Schema.Literals(["queued", "running", "cancelling", "cancelled", "exited", "failed"]),
  sourceHash: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
  language: Schema.Literals(["javascript", "typescript", "python", "shell", "wasm"]),
  startedAt: Schema.Int,
  finishedAt: Schema.NullOr(Schema.Int),
  output: Schema.NullOr(ObservedOutput),
});
export const RunSummary = RunRecord.mapFields((fields) => Struct.omit(fields, ["output"]));
export const RunMetadata = Schema.Struct({ summary: Schema.fromJsonString(RunSummary) });
export const StdioRef = Schema.Struct({
  size: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 2_097_152 })),
  chunks: Schema.Array(Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/))).check(
    Schema.isMaxLength(32),
  ),
});
export const StoredOutput = ObservedOutput.mapFields((fields) => ({
  ...fields,
  stdout: StdioRef,
  stderr: StdioRef,
}));
export const StoredRun = RunRecord.mapFields((fields) => ({
  ...fields,
  output: Schema.NullOr(StoredOutput),
  authority: Schema.NullOr(Capability),
  deadlineAt: Schema.NullOr(Schema.Int),
}));
export const StoredRunMetadata = RunMetadata.mapFields((fields) => ({
  ...fields,
  format: Schema.Literal("run-v3"),
}));
export const DispatchReceipt = Schema.Struct({ notifications: Schema.Int });
export const ProcessDelivery = Schema.Struct({ key: Schema.String, eTag: Schema.String });
export const ProcessPage = Schema.Struct({
  items: Schema.Array(RunSummary),
  cursor: Schema.NullOr(Schema.String),
});
export const ProcessOutputPage = Schema.Struct({
  state: RunRecord.fields.status,
  availability: Schema.Literals(["pending", "retained", "unobserved"]),
  events: Schema.Array(
    Schema.Struct({
      stream: Schema.Literals(["stdout", "stderr"]),
      offset: Schema.Int,
      cursor: Schema.Int,
      data: Schema.String,
      encoding: Schema.Literal("base64"),
    }),
  ).check(Schema.isMaxLength(128)),
  nextCursor: Schema.Int,
  hasMore: Schema.Boolean,
  truncated: Schema.Literal(false),
});
export const LiveOutputPage = ProcessOutputPage.mapFields((fields) => ({
  ...fields,
  nextCursor: LiveOutputCursor,
}));
export const FileContent = Schema.Struct({
  content: Schema.String,
  encoding: Schema.Literal("base64"),
  size: Schema.Int,
});
export const BatchReadResults = Schema.Array(
  Schema.Union([
    Schema.Struct({ path: Path, content: Content, encoding: Schema.Literal("base64") }),
    Schema.Struct({
      path: Path,
      content: Schema.Null,
      encoding: Schema.Literal("base64"),
      error: Schema.String,
      code: Schema.String,
    }),
  ]),
);
export const BatchWriteResults = Schema.Array(
  Schema.Union([
    Schema.Struct({ path: Path, success: Schema.Literal(true) }),
    Schema.Struct({
      path: Path,
      success: Schema.Literal(false),
      error: Schema.String,
      code: Schema.String,
    }),
  ]),
);
export const DirectoryTree = Schema.Array(
  Schema.Struct({
    path: Path,
    type: Schema.Literals(["file", "directory", "symlink"]),
    size: Schema.Int,
  }),
);
export const CanonicalPath = Schema.Struct({ path: Path });
export const Success = Schema.Struct({ ok: Schema.Literal(true) });
export const TokenResponse = Schema.Struct({ token: Schema.String, expiresAt: Schema.Int });
export const Status = Schema.Struct({
  id: Id,
  generation: Schema.Int,
  filesystemBytes: Schema.Int,
  policy: Policy,
});
export const NetworkResult = Schema.Struct({
  status: Schema.Int,
  headers: NetworkHeaders,
  content: Schema.String,
  encoding: Schema.Literal("base64"),
});
export const Exists = Schema.Struct({ exists: Schema.Boolean });
export const Link = Schema.Struct({ target: Schema.String });
export const PackagePreparation = Schema.Struct({
  installed: Schema.Struct({
    packageId: Digest,
    digest: SourceDigest,
    sizeBytes: Schema.Int,
    manifest: Schema.Struct({
      name: Schema.String,
      version: Schema.String,
      provides: Schema.NullOr(
        Schema.Struct({
          env: Schema.Record(Schema.String, Schema.String),
          files: Schema.Array(Schema.Struct({ source: Schema.String, target: Schema.String })),
        }),
      ),
      commands: Schema.Array(Schema.Struct({ command: Schema.String, entry: Schema.String })),
      man_pages: Schema.Array(Schema.Struct({ section: Schema.String, page: Schema.String })),
    }),
  }),
  root: Path,
  entries: Schema.Array(
    Schema.Struct({
      path: Path,
      node: Schema.Union([
        Schema.Struct({
          kind: Schema.Literal("file"),
          mode: Schema.Int,
          size: Schema.Int,
          chunks: Schema.Array(Schema.String),
        }),
        Schema.Struct({ kind: Schema.Literal("directory"), mode: Schema.Int }),
        Schema.Struct({ kind: Schema.Literal("symlink"), target: Schema.String }),
      ]),
      uid: Schema.Int,
      gid: Schema.Int,
      mtimeNs: Schema.String.check(Schema.isPattern(/^[0-9]+$/)),
    }),
  ),
  blocks: Schema.Array(
    Schema.Struct({ hash: Schema.String, offset: Schema.Int, length: Schema.Int }),
  ),
});

export const SoftwareCatalog = Schema.Array(PackagePreparation.fields.installed);
export const PackageInstallation = PackagePreparation.mapFields((fields) =>
  Struct.pick(fields, ["installed", "blocks"]),
);

export const GuestResponse = Schema.Union([
  LiveOutputPage,
  ProcessOutputPage,
  PackagePreparation.fields.installed,
  SoftwareCatalog,
  BatchReadResults,
  BatchWriteResults,
  DirectoryTree,
  CanonicalPath,
  FileContent,
  FileStat,
  DirectoryEntries,
  Success,
  NetworkResult,
  Exists,
  Link,
  RunRecord,
  RunSummary,
  ProcessPage,
]);
export const ErrorResponse = Schema.Struct({ error: Schema.String, message: Schema.String });
export class Fault extends Schema.TaggedError<Fault>()("Fault", {
  code: Schema.String,
  status: Schema.Int,
  message: Schema.String,
}) {}

export const ShellPlan = Schema.Array(
  Schema.Struct({
    argv: Schema.Array(Schema.String).check(Schema.isMinLength(1)),
    gate: Schema.Literals(["always", "pipe", "success", "failure"]),
    pipe: Schema.Boolean,
    input: Schema.NullOr(Schema.String),
    output: Schema.NullOr(Schema.String),
    append: Schema.Boolean,
  }),
);
export const CommandOutput = Schema.Struct({
  stdout: Schema.String,
  stderr: Schema.String,
  exitCode: Schema.Int,
});
export const CommandArguments = Schema.Array(Schema.String);

export const MigrationReceipt = Schema.Struct({ migrated: Schema.Int });
