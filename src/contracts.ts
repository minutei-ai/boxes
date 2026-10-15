import wasmModuleBytes from "./wasm-module-bytes.json";
import { Schema, Struct } from "effect";

export const Id = Schema.String.check(Schema.isPattern(/^[a-zA-Z0-9_-]{1,64}$/));
export const Path = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4096));
export const ContentEncoding = Schema.Literals(["utf8", "base64"]);
export const Content = Schema.String.check(Schema.isMaxLength(22_369_624));
export const Environment = Schema.Record(
  Schema.String.check(Schema.isPattern(/^[^=\0]{1,128}$/)),
  Schema.String.check(Schema.isMaxLength(4096), Schema.isPattern(/^[^\0]*$/)),
).check(Schema.isMaxProperties(128));
export const Permission = Schema.Literals(["read", "write", "execute", "network", "manage"]);
export const Policy = Schema.Struct({
  networkHosts: Schema.Array(Schema.String.check(Schema.isPattern(/^[a-z0-9.-]{1,253}$/))).check(
    Schema.isMaxLength(32),
  ),
  interruptBudget: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 100_000 })),
  memoryBytes: Schema.Int.check(Schema.isBetween({ minimum: 4_194_304, maximum: 33_554_432 })),
  maxOutputBytes: Schema.Int.check(Schema.isBetween({ minimum: 1024, maximum: 1_048_576 })),
});
const utf8 = new TextEncoder();
const ConfiguredEnvironment = Environment.check(
  Schema.makeFilter(
    (values) =>
      Object.keys(values).every((key) => key.isWellFormed()) &&
      Object.values(values).every(
        (value) => value.isWellFormed() && utf8.encode(value).byteLength <= 4096,
      ) &&
      utf8.encode(Schema.encodeSync(Schema.fromJsonString(Environment))(values)).byteLength <=
        65_536,
  ),
);
export const Configuration = Policy.mapFields((fields) => ({
  ...fields,
  environment: ConfiguredEnvironment,
}));
export const PolicyPatch = Policy.mapFields((fields) => Struct.map(fields, Schema.optionalKey));
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
  version: Schema.Literal(3),
  environment: Configuration.fields.environment,
  manifest: Schema.String.check(Schema.isMaxLength(8_388_608)),
  policy: Policy,
  createdAt: Schema.Int,
  deleted: Schema.Boolean,
});

export const DirectoryExclusions = Schema.Array(
  Schema.String.check(Schema.isPattern(/^[^/\0]{1,255}$/)),
).check(Schema.isMaxLength(128));

const OwnerId = Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 4_294_967_295 }));
export const FileStat = Schema.Struct({
  path: Path,
  kind: Schema.Literals(["file", "directory", "symlink"]),
  size: Schema.Int,
  mode: Schema.Int,
  inode: Schema.Int,
  nlink: Schema.Int,
  uid: OwnerId,
  gid: OwnerId,
  atimeNs: Schema.String.check(Schema.isPattern(/^\d+$/)),
  mtimeNs: Schema.String.check(Schema.isPattern(/^\d+$/)),
  ctimeNs: Schema.String.check(Schema.isPattern(/^\d+$/)),
});
const SnapshotMetadata = {
  path: FileStat.fields.path,
  mode: Schema.String.check(Schema.isPattern(/^0[0-7]{1,4}$/)),
  uid: FileStat.fields.uid,
  gid: FileStat.fields.gid,
};
export const FilesystemSnapshot = Schema.Struct({
  kind: Schema.Literal("snapshot-export"),
  source: Schema.Struct({
    format: Schema.Literal("boxes-filesystem-snapshot-v1"),
    filesystem: Schema.Struct({
      entries: Schema.Array(
        Schema.Union([
          Schema.Struct({ path: Path, type: Schema.Literal("hardlink"), target: Path }),
          Schema.Struct({ ...SnapshotMetadata, type: Schema.Literal("directory") }),
          Schema.Struct({ ...SnapshotMetadata, type: Schema.Literal("symlink"), target: Path }),
          Schema.Struct({
            ...SnapshotMetadata,
            type: Schema.Literal("file"),
            content: Content,
            encoding: Schema.Literal("base64"),
          }),
        ]),
      ).check(Schema.isMaxLength(16_384)),
    }),
  }),
});

const Nanoseconds = Schema.String.check(Schema.isPattern(/^(0|[1-9][0-9]{0,19})$/))
  .pipe(Schema.decodeTo(Schema.BigIntFromString))
  .check(Schema.isBetweenBigInt({ minimum: 0n, maximum: 18_446_744_073_709_551_615n }));
const FileOffset = Schema.Int.check(
  Schema.isBetween({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
);
export const FilesystemAction = Schema.Union([
  Schema.Struct({ op: Schema.Literal("filesystem.restore"), snapshot: FilesystemSnapshot }),
  Schema.Struct({
    op: Schema.Literal("filesystem.utimes"),
    path: Path,
    atimeNs: Nanoseconds,
    mtimeNs: Nanoseconds,
    follow: Schema.Boolean,
  }),
  Schema.Struct({
    op: Schema.Literal("filesystem.export"),
    maxBytes: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 25_165_824 })),
  }),
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
    offset: Schema.optionalKey(FileOffset),
    length: Schema.optionalKey(
      Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 16_777_216 })),
    ),
  }),
  Schema.Struct({
    op: Schema.Literal("filesystem.writeFile"),
    path: Path,
    offset: Schema.optionalKey(FileOffset),
    content: Content,
    encoding: ContentEncoding,
  }),
  Schema.Struct({ op: Schema.Literal("filesystem.appendFile"), path: Path, content: Content }),
  Schema.Struct({ op: Schema.Literal("filesystem.stat"), path: Path, follow: Schema.Boolean }),
  Schema.Struct({ op: Schema.Literal("filesystem.exists"), path: Path }),
  Schema.Struct({ op: Schema.Literal("filesystem.mkdir"), path: Path, recursive: Schema.Boolean }),
  Schema.Struct({ op: Schema.Literal("filesystem.readdir"), path: Path }),
  Schema.Struct({
    op: Schema.Literal("filesystem.link"),
    from: Path,
    to: Path,
    follow: Schema.Boolean,
  }),
  Schema.Struct({ op: Schema.Literal("filesystem.move"), from: Path, to: Path }),
  Schema.Struct({ op: Schema.Literal("filesystem.remove"), path: Path, recursive: Schema.Boolean }),
  Schema.Struct({ op: Schema.Literal("filesystem.symlink"), path: Path, target: Path }),
  Schema.Struct({ op: Schema.Literal("filesystem.readlink"), path: Path }),
  Schema.Struct({
    op: Schema.Literal("filesystem.chown"),
    path: Path,
    uid: OwnerId,
    gid: OwnerId,
    follow: Schema.Boolean,
  }),
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
export const ProcessInputAction = Schema.Union([
  Schema.Struct({
    op: Schema.Literal("process.stdin.write"),
    id: Id,
    offset: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 16_777_216 })),
    content: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(87_384)),
    encoding: ContentEncoding,
  }),
  Schema.Struct({
    op: Schema.Literal("process.stdin.close"),
    id: Id,
    offset: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 16_777_216 })),
  }),
  Schema.Struct({ op: Schema.Literal("process.stdin.status"), id: Id }),
]);
export const InputReceipt = Schema.Struct({
  offset: Schema.Int,
  total: Schema.Int,
  closed: Schema.Boolean,
});
export const InputHead = Schema.Struct({
  version: Schema.Literal(1),
  size: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 16_777_216 })),
  closed: Schema.Boolean,
  chunks: Schema.Array(
    Schema.Struct({
      hash: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
      size: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 65_536 })),
    }),
  ).check(Schema.isMaxLength(1024)),
});
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
export const ProcessRecoveryAction = Schema.Struct({
  op: Schema.Literal("process.recovery.status"),
  id: Id,
});
export const ProcessReadAction = Schema.Union([
  ProcessRecoveryAction,
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
  env: Schema.optionalKey(Environment),
  source: Schema.String.check(Schema.isMaxLength(1_048_576)),
});
const ScriptSource = Schema.String.check(Schema.isMaxLength(1_048_576));
const WasmSource = Schema.String.check(Schema.isMaxLength(Math.ceil(wasmModuleBytes / 3) * 4));
export const WasmConfiguration = Schema.Struct({
  argv: Schema.Array(
    Schema.String.check(Schema.isMaxLength(4096), Schema.isPattern(/^[^\0]*$/)),
  ).check(Schema.isMaxLength(129)),
  env: Environment,
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
    env: Schema.optionalKey(Environment),
    source: ScriptSource,
    filePath: Schema.optionalKey(Path),
  }),
  Schema.Struct({
    op: Schema.Literal("python.evaluate"),
    id: Id,
    env: Schema.optionalKey(Environment),
    expression: ScriptSource,
    filePath: Schema.optionalKey(Path),
  }),
  Schema.Struct({
    op: Schema.Literal("python.executeFile"),
    id: Id,
    path: Path,
    env: Schema.optionalKey(Environment),
  }),
]);
export const PythonProgram = Schema.Struct({
  env: Environment,
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
    env: Schema.optionalKey(Environment),
    source: ScriptSource,
    filePath: Schema.optionalKey(Path),
  }),
  Schema.Struct({
    op: Schema.Literals(["javascript.evaluate", "typescript.evaluate"]),
    id: Id,
    env: Schema.optionalKey(Environment),
    expression: ScriptSource,
    filePath: Schema.optionalKey(Path),
  }),
  Schema.Struct({
    op: Schema.Literals(["javascript.executeFile", "typescript.executeFile"]),
    id: Id,
    env: Schema.optionalKey(Environment),
    path: Path,
  }),
]);
export const SpawnAction = Schema.Struct({
  op: Schema.Literal("process.spawn"),
  execution: RunAction,
  stdinMode: Schema.optionalKey(Schema.Literals(["closed", "pipe"])),
});
export const HostCall = Schema.Struct({
  op: Schema.Literal("host.call"),
  name: Schema.String.check(Schema.isPattern(/^[a-zA-Z_$][a-zA-Z0-9_$-]{0,127}$/)),
  input: Schema.optionalKey(Schema.UndefinedOr(Schema.Json)),
});
export const HostReply = Schema.Union([
  Schema.Struct({
    ok: Schema.Literal(true),
    value: Schema.optionalKey(Schema.UndefinedOr(Schema.Json)),
  }),
  Schema.Struct({
    ok: Schema.Literal(false),
    message: Schema.String.check(Schema.isMaxLength(8192)),
  }),
]);
export const AgentInput = Schema.Struct({
  id: Id,
  memoryBytes: Schema.optionalKey(Policy.fields.memoryBytes),
  source: InlineRun.fields.source,
  tools: Schema.Array(HostCall.fields.name).check(Schema.isMaxLength(128)),
  maxToolCalls: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 256 })),
  timeoutMs: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 30000 })),
});
export const AgentRequest = Schema.Struct({
  ...AgentInput.fields,
  sandboxId: Id,
  token: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(2048)),
});
export const CronAction = Schema.Union([
  Schema.Struct({
    op: Schema.Literal("cron.schedule"),
    id: Id,
    schedule: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256)),
    execution: RunAction,
    overlap: Schema.Literals(["allow", "skip", "queue"]),
  }),
  Schema.Struct({ op: Schema.Literal("cron.get"), id: Id }),
  Schema.Struct({ op: Schema.Literal("cron.cancel"), id: Id }),
  Schema.Struct({
    op: Schema.Literal("cron.list"),
    limit: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 100 })),
    cursor: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(2048))),
  }),
]);
export const CronRecord = Schema.Struct({
  ...CronAction.members[0].fields,
  op: Schema.Literal("cron.schedule"),
  state: Schema.Literals(["active", "cancelled", "completed", "expired", "failed"]),
  createdAt: Schema.Int,
  nextRun: Schema.NullOr(Schema.Int),
  lastRun: Schema.NullOr(Schema.Int),
  runCount: Schema.Int,
  lastProcessId: Schema.NullOr(Id),
  error: Schema.NullOr(Schema.String),
});
export const StoredCron = Schema.Struct({
  ...CronRecord.fields,
  authority: Capability,
  pendingAt: Schema.NullOr(Schema.Int),
});
export const CronPage = Schema.Struct({
  jobs: Schema.Array(CronRecord),
  cursor: Schema.NullOr(Schema.String),
});
export const GuestAction = Schema.Union([
  InlineRun.mapFields((fields) => ({ ...fields, language: Schema.Literal("shell") })),
  CronAction,
  SpawnAction,
  FilesystemAction,
  NetworkAction,
  ProcessReadAction,
  ProcessCancelAction,
  ProcessInputAction,
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
  env: Environment,
  language: Schema.Literals(["javascript", "typescript"]),
  entry: Path,
  mode: Schema.Literals(["function", "module", "evaluate"]),
  modules: Schema.Array(ModuleSource).check(Schema.isMinLength(1), Schema.isMaxLength(128)),
});
export const ModuleBatch = Schema.Struct({
  entry: Path,
  modules: Schema.Array(ModuleSource).check(Schema.isMaxLength(128)),
});
export const ShellProgram = Schema.Struct({
  language: Schema.Literal("shell"),
  source: ScriptSource,
  env: Environment,
});
export const Program = Schema.Union([ScriptProgram, WasmProgram, PythonProgram, ShellProgram]);
export const Action = Schema.Union([
  GuestAction,
  RunAction,
  Schema.Struct({ op: Schema.Literal("config.get") }),
  Schema.Struct({
    op: Schema.Literal("config.set"),
    policy: Policy,
    environment: Schema.optionalKey(Configuration.fields.environment),
  }),
  Schema.Struct({
    op: Schema.Literal("config.patch"),
    policy: PolicyPatch,
    environment: Schema.optionalKey(Configuration.fields.environment),
  }),
  Schema.Struct({ op: Schema.Literal("vm.status") }),
  Schema.Struct({ op: Schema.Literal("vm.dispose") }),
  Schema.Struct({
    op: Schema.Literal("vm.reclaim"),
    limit: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 1000 })),
  }),
]);
export const CreateSandbox = Schema.Struct({
  environment: Schema.optionalKey(Configuration.fields.environment),
  id: Id,
  policy: Policy,
  snapshot: Schema.optionalKey(FilesystemSnapshot),
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
  offset: FileOffset,
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
export const CapturedBytes = RunResult.mapFields((fields) => ({
  ...Struct.pick(fields, ["stdout", "stderr"]),
  stdout: Schema.Uint8Array,
  stderr: Schema.Uint8Array,
}));
export const CapturedStdio = Schema.Union([
  RunResult.mapFields((fields) => Struct.pick(fields, ["stdout", "stderr"])),
  CapturedBytes,
]);
export const ObservedOutput = RunResult.mapFields((fields) => ({
  ...fields,
  exitCode: Schema.NullOr(fields.exitCode),
}));
export const ToolStep = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("request"), action: Schema.fromJsonString(GuestAction) }),
  Schema.Struct({ kind: Schema.Literal("done"), output: Schema.fromJsonString(RunResult) }),
]);

export const SpawnStageResult = Schema.Struct({
  errno: Schema.Literals([0, 8, 28, 33, 44, 48, 54]),
  path: Schema.NullOr(Path),
});
export const WasiOpen = Schema.Struct({
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
});

export const WasmStep = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("exec"),
    path: Schema.NullOr(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4096))),
    fd: Schema.NullOr(Schema.Int),
    cwd: Path,
    argv: WasmConfiguration.fields.argv,
    env: WasmConfiguration.fields.env,
  }),
  Schema.Struct({ kind: Schema.Literal("stopped") }),
  Schema.Struct({
    kind: Schema.Literal("spawn"),
    path: Schema.String.check(
      Schema.isMinLength(1),
      Schema.isMaxLength(4096),
      Schema.isPattern(/^[^\0]*$/),
    ),
    searchPath: Schema.NullOr(
      Schema.String.check(Schema.isMaxLength(65536), Schema.isPattern(/^[^\0]*$/)),
    ),
    cwdSteps: Schema.Array(
      Schema.String.check(
        Schema.isMinLength(1),
        Schema.isMaxLength(4096),
        Schema.isPattern(/^[^\0]*$/),
      ),
    ).check(Schema.isMinLength(1), Schema.isMaxLength(130)),
    argv: WasmConfiguration.fields.argv,
    env: WasmConfiguration.fields.env,
    actions: Schema.Array(
      Schema.Struct({
        command: Schema.Literals([1, 2, 3, 4, 5, 6]),
        fd: Schema.Int,
        source: Schema.Int,
        flags: Schema.Int,
        mode: Schema.Int,
        path: Schema.String.check(Schema.isMaxLength(4096)),
      }),
    ).check(Schema.isMaxLength(128)),
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
  WasiOpen,
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
  Schema.Struct({
    kind: Schema.Literal("mkdir"),
    path: Path,
    base: Path,
    mode: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 511 })),
  }),
  Schema.Struct({
    kind: Schema.Literal("remove"),
    path: Path,
    base: Path,
    directory: Schema.Boolean,
  }),
  Schema.Struct({
    kind: Schema.Literal("link"),
    from: Path,
    fromBase: Path,
    to: Path,
    toBase: Path,
    follow: Schema.Boolean,
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
export const ReclamationPhase = Schema.Literals([
  "processes",
  "inputs",
  "schedules",
  "objects",
  "complete",
]);
export const ReclamationState = Schema.Struct({ phase: ReclamationPhase, revision: Id });
export const ReclamationProgress = Schema.Struct({
  phase: ReclamationPhase,
  status: Schema.Literals(["pending", "blocked", "complete"]),
  removed: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  blocking: Schema.Array(Id),
});
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
  stdinMode: Schema.Literals(["closed", "pipe"]),
  checkpointCount: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 1_000_000 })),
  checkpoint: Schema.NullOr(Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/))),
}));
export const RecoveryStatus = StoredRun.mapFields((fields) => ({
  state: fields.status,
  checkpoints: fields.checkpointCount,
  resumable: Schema.Boolean,
  deadlineAt: fields.deadlineAt,
}));
export const StoredRunMetadata = RunMetadata.mapFields((fields) => ({
  ...fields,
  format: Schema.Literal("run-v5"),
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
      uid: OwnerId,
      gid: OwnerId,
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

export const ErrorResponse = Schema.Struct({ error: Schema.String, message: Schema.String });
export const AgentReply = Schema.Union([
  Schema.Struct({ ok: Schema.Literal(true), record: RunRecord }),
  Schema.Struct({ ok: Schema.Literal(false), status: Schema.Int, ...ErrorResponse.fields }),
]);
export class Fault extends Schema.TaggedError<Fault>()("Fault", {
  code: Schema.String,
  status: Schema.Int,
  message: Schema.String,
}) {}

export const ShellBuiltin = Schema.NullOr(
  Schema.Struct({
    ...Struct.pick(RunResult.fields, ["stdout", "stderr", "exitCode"]),
    fatal: Schema.Boolean,
  }),
);
export const ShellPlan = Schema.Array(
  Schema.Struct({
    gate: Schema.Literals(["always", "pipe", "success", "failure"]),
    pipe: Schema.Boolean,
    negate: Schema.Boolean,
    redirects: Schema.Array(
      Schema.Union([
        Schema.Struct({ kind: Schema.Literal("input") }),
        Schema.Struct({
          kind: Schema.Literals(["output", "error"]),
          append: Schema.Boolean,
        }),
      ]),
    ).check(Schema.isMaxLength(128)),
  }),
);
export const CommandArguments = Schema.Array(Schema.String);

export const OutputMigrationInput = Schema.Struct({
  cursor: Schema.optionalKey(Schema.NullOr(Schema.String)),
});
export const OutputMigrationReceipt = Schema.Struct({
  migrated: Schema.Int,
  cursor: Schema.NullOr(Schema.String),
});
export const ProcessDeadlineMigrationInput = Schema.Struct({
  cursor: Schema.optionalKey(Schema.NullOr(Schema.String.check(Schema.isMaxLength(2048)))),
});
export const ProcessDeadlineMigrationReceipt = Schema.Struct({
  migrated: Schema.Int,
  cursor: Schema.NullOr(Schema.String.check(Schema.isMaxLength(2048))),
});
const FilesystemMigrationCursor = Schema.Struct({
  phase: Schema.Literals(["heads", "checkpoints"]),
  continuation: Schema.NullOr(Schema.String.check(Schema.isMaxLength(2048))),
});
export const FilesystemMigrationInput = Schema.Struct({
  cursor: Schema.optionalKey(Schema.NullOr(FilesystemMigrationCursor)),
});
export const FilesystemMigrationReceipt = Schema.Struct({
  migrated: Schema.Int,
  cursor: Schema.NullOr(FilesystemMigrationCursor),
});
const EnvironmentMigrationCursor = Schema.Struct({
  phase: Schema.Literals(["heads", "processes"]),
  continuation: Schema.NullOr(Schema.String.check(Schema.isMaxLength(2048))),
});
export const EnvironmentMigrationInput = Schema.Struct({
  cursor: Schema.optionalKey(Schema.NullOr(EnvironmentMigrationCursor)),
});
export const EnvironmentMigrationReceipt = Schema.Struct({
  migrated: Schema.Int,
  cursor: Schema.NullOr(EnvironmentMigrationCursor),
});
export const MigrationReceipt = Schema.Struct({ migrated: Schema.Int });

export const HeapSnapshot = Schema.Struct({
  version: Schema.Literal(1),
  runtime: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
  memoryBytes: Schema.Int.check(Schema.isBetween({ minimum: 65_536, maximum: 67_108_864 })),
  pages: Schema.Array(Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/))).check(
    Schema.isMaxLength(1024),
  ),
  handles: Schema.Array(
    Schema.Struct({
      pid: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 2147483647 })),
      handle: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 4294967295 })),
    }),
  ).check(Schema.isMinLength(1), Schema.isMaxLength(9)),
});

export const ExecutionCheckpoint = Schema.Struct({
  version: Schema.Literal(1),
  heap: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
  manifest: Schema.String.check(Schema.isMaxLength(8_388_608)),
  head: Head,
  etag: Schema.String,
  dirty: Schema.Boolean,
  checkpointManifest: Schema.String.check(Schema.isMaxLength(8_388_608)),
  monotonic: Schema.String.check(Schema.isPattern(/^[0-9]+$/)),
  savedAt: Schema.Int,
  fuelUsed: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 100_000_000 })),
});

export const ActionResponses = {
  "cron.schedule": CronRecord,
  "cron.get": CronRecord,
  "cron.list": CronPage,
  "cron.cancel": Success,
  "filesystem.restore": Success,
  "filesystem.utimes": Success,
  "filesystem.export": FilesystemSnapshot,
  "filesystem.readFiles": BatchReadResults,
  "filesystem.writeFiles": BatchWriteResults,
  "filesystem.readdirRecursive": DirectoryTree,
  "filesystem.realpath": CanonicalPath,
  "filesystem.readFile": FileContent,
  "filesystem.writeFile": Success,
  "filesystem.appendFile": Success,
  "filesystem.stat": FileStat,
  "filesystem.exists": Exists,
  "filesystem.mkdir": Success,
  "filesystem.readdir": DirectoryEntries,
  "filesystem.link": Success,
  "filesystem.move": Success,
  "filesystem.remove": Success,
  "filesystem.symlink": Success,
  "filesystem.readlink": Link,
  "filesystem.chown": Success,
  "filesystem.chmod": Success,
  "filesystem.truncate": Success,
  "network.fetch": NetworkResult,
  "process.list": ProcessPage,
  "process.wait": RunRecord,
  "process.cancel": RunSummary,
  "process.stdin.write": InputReceipt,
  "process.stdin.close": InputReceipt,
  "process.stdin.status": InputReceipt,
  "process.output.read": ProcessOutputPage,
  "process.output.readLive": LiveOutputPage,
  "process.recovery.status": RecoveryStatus,
  "process.get": RunRecord,
  "software.install": PackagePreparation.fields.installed,
  "software.list": SoftwareCatalog,
  "software.installed": SoftwareCatalog,
  "software.uninstall": Success,
  "software.link": Success,
  "process.run": RunRecord,
  "python.execute": RunRecord,
  "python.evaluate": RunRecord,
  "python.executeFile": RunRecord,
  "wasm.executeFile": RunRecord,
  "process.execFile": RunRecord,
  "javascript.execute": RunRecord,
  "typescript.execute": RunRecord,
  "javascript.evaluate": RunRecord,
  "typescript.evaluate": RunRecord,
  "javascript.executeFile": RunRecord,
  "typescript.executeFile": RunRecord,
  "process.spawn": RunRecord,
  "config.get": Configuration,
  "config.set": Configuration,
  "config.patch": Configuration,
  "vm.status": Status,
  "vm.dispose": Success,
  "vm.reclaim": ReclamationProgress,
} satisfies Record<typeof Action.Type.op, Schema.Constraint>;
