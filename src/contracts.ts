import { Schema, Struct } from "effect";

export const Id = Schema.String.check(Schema.isPattern(/^[a-zA-Z0-9_-]{1,64}$/));
export const Path = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4096));
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

export const FilesystemAction = Schema.Union([
  Schema.Struct({ op: Schema.Literal("filesystem.readFile"), path: Path }),
  Schema.Struct({
    op: Schema.Literal("filesystem.writeFile"),
    path: Path,
    content: Content,
    encoding: Schema.Literals(["utf8", "base64"]),
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
export const NetworkAction = Schema.Struct({
  op: Schema.Literal("network.fetch"),
  url: Schema.String.check(Schema.isMaxLength(8192)),
});
export const ProcessListAction = Schema.Struct({
  op: Schema.Literal("process.list"),
  limit: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 50 })),
  cursor: Schema.NullOr(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4096))),
});
export const ProcessReadAction = Schema.Union([
  Schema.Struct({ op: Schema.Literal("process.get"), id: Id }),
  ProcessListAction,
]);
export const GuestAction = Schema.Union([FilesystemAction, NetworkAction, ProcessReadAction]);
const InlineRun = Schema.Struct({
  op: Schema.Literal("process.run"),
  id: Id,
  language: Schema.Literals(["javascript", "typescript", "python", "shell", "wasm"]),
  source: Schema.String.check(Schema.isMaxLength(1_048_576)),
});
const ScriptSource = Schema.String.check(Schema.isMaxLength(1_048_576));
export const RunAction = Schema.Union([
  InlineRun,
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
  Schema.Struct({ language: Schema.Literals(["python", "shell", "wasm"]), source: ScriptSource }),
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
});
export const DirectoryEntries = Schema.Array(
  Schema.Struct({ name: Schema.String, kind: Schema.Literals(["file", "directory", "symlink"]) }),
);
export const Chunks = Schema.Array(Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)));
export const RunResult = Schema.Struct({
  stdout: Schema.String,
  stderr: Schema.String,
  result: Schema.Unknown,
  exitCode: Schema.Int,
});
export const RunRecord = Schema.Struct({
  id: Id,
  status: Schema.Literals(["running", "exited", "failed"]),
  sourceHash: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
  language: Schema.Literals(["javascript", "typescript", "python", "shell", "wasm"]),
  startedAt: Schema.Int,
  finishedAt: Schema.NullOr(Schema.Int),
  output: Schema.NullOr(RunResult),
});
export const RunSummary = RunRecord.mapFields((fields) => Struct.omit(fields, ["output"]));
export const RunMetadata = Schema.Struct({ summary: Schema.fromJsonString(RunSummary) });
export const ProcessPage = Schema.Struct({
  items: Schema.Array(RunSummary),
  cursor: Schema.NullOr(Schema.String),
});
export const FileContent = Schema.Struct({
  content: Schema.String,
  encoding: Schema.Literal("base64"),
  size: Schema.Int,
});
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
  content: Schema.String,
  encoding: Schema.Literal("base64"),
});
export const Exists = Schema.Struct({ exists: Schema.Boolean });
export const Link = Schema.Struct({ target: Schema.String });
export const GuestResponse = Schema.Union([
  FileContent,
  FileStat,
  DirectoryEntries,
  Success,
  NetworkResult,
  Exists,
  Link,
  RunRecord,
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
