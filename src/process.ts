import { Clock, Effect, Schema, Struct } from "effect";
import { requirePermission } from "./auth";
import {
  Capability,
  Fault,
  RunAction,
  RunMetadata,
  RunRecord,
  RunResult,
  ProcessListAction,
} from "./contracts";
import { readBounded } from "./http";
import { open, StorageFailure } from "./storage";
import type { Env } from "./resources";
import { shell } from "./shell";
import guestSource from "../dist/guest-source.json";

export class ExecutionFailure extends Schema.TaggedError<ExecutionFailure>()("ExecutionFailure", {
  cause: Schema.Unknown,
}) {}
export const run = Effect.fn("process.run")(function* (
  env: Env,
  ctx: ExecutionContext,
  capability: typeof Capability.Type,
  action: typeof RunAction.Type,
) {
  yield* requirePermission(capability, "execute");
  const session = yield* open(env, capability.sandboxId);
  const startedAt = yield* Clock.currentTimeMillis;
  const key = `sandboxes/${capability.sandboxId}/runs/${action.id}.json`;
  if (
    action.language === "wasm" &&
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(action.source)
  )
    return yield* new Fault({
      code: "EINVAL",
      status: 400,
      message: "Invalid canonical Wasm base64",
    });
  const source = yield* Effect.sync(() => {
    if (action.language === "wasm") return Buffer.from(action.source, "base64");
    return Buffer.from(action.source, "utf8");
  });
  const digest = yield* Effect.promise(() => crypto.subtle.digest("SHA-256", source));
  const sourceHash = Buffer.from(digest).toString("hex");
  yield* Effect.tryPromise({
    try: () =>
      env.OBJECTS.put(`sandboxes/${capability.sandboxId}/code/${sourceHash}`, source, {
        onlyIf: { etagDoesNotMatch: "*" },
      }),
    catch: (cause) => new StorageFailure({ cause }),
  });
  const record: typeof RunRecord.Type = {
    id: action.id,
    status: "running",
    sourceHash,
    language: action.language,
    startedAt,
    finishedAt: null,
    output: null,
  };
  const receipt = yield* Effect.tryPromise({
    try: () =>
      env.OBJECTS.put(key, Schema.encodeSync(Schema.fromJsonString(RunRecord))(record), {
        onlyIf: { etagDoesNotMatch: "*" },
        customMetadata: Schema.encodeSync(RunMetadata)({
          summary: Struct.omit(record, ["output"]),
        }),
      }),
    catch: (cause) => new StorageFailure({ cause }),
  });
  if (receipt === null)
    return yield* new Fault({
      code: "EEXIST",
      status: 409,
      message: "Execution ID already exists; use process.get to inspect its confirmed state",
    });
  const guest = ctx.exports.Guest({ props: capability });
  const code: WorkerLoaderWorkerCode = yield* Effect.sync((): WorkerLoaderWorkerCode => {
    if (action.language === "wasm")
      return {
        compatibilityDate: "2026-10-06",
        mainModule: "index.js",
        modules: {
          "index.js":
            "import module from './program.wasm'; export default { fetch() { const instance = new WebAssembly.Instance(module, {}); const result = instance.exports.run(); return Response.json({stdout:'',stderr:'',result,exitCode:0}); } };",
          "program.wasm": { wasm: source },
        },
        env: {},
        globalOutbound: null,
        limits: { cpuMs: session.head.policy.cpuMs, subRequests: 0 },
      };
    if (action.language === "python")
      return {
        compatibilityDate: "2026-10-06",
        compatibilityFlags: ["python_workers"],
        mainModule: "index.py",
        modules: {
          "index.py": {
            py: `import json\nimport io\nimport contextlib\nfrom workers import Response, WorkerEntrypoint\nfrom program import main\n\nclass Default(WorkerEntrypoint):\n    async def fetch(self, request):\n        stdout = io.StringIO()\n        stderr = io.StringIO()\n        with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):\n            result = await main(self.env.TOOLS)\n        return Response(json.dumps({"stdout": stdout.getvalue(), "stderr": stderr.getvalue(), "result": result, "exitCode": 0}), headers={"content-type": "application/json"})\n`,
          },
          "program.py": { py: action.source },
        },
        env: { TOOLS: guest, MAX_OUTPUT: session.head.policy.maxOutputBytes },
        globalOutbound: null,
        limits: { cpuMs: session.head.policy.cpuMs, subRequests: 256 },
      } satisfies WorkerLoaderWorkerCode;
    return {
      compatibilityDate: "2026-10-06",
      compatibilityFlags: ["nodejs_compat"],
      mainModule: "index.js",
      modules: { "index.js": guestSource, "program.js": action.source },
      env: { TOOLS: guest, MAX_OUTPUT: session.head.policy.maxOutputBytes },
      globalOutbound: null,
      limits: { cpuMs: session.head.policy.cpuMs, subRequests: 256 },
    } satisfies WorkerLoaderWorkerCode;
  });
  const output = yield* Effect.gen(function* () {
    if (action.language === "shell") return yield* shell(env, capability, action.source);
    const stub = yield* Effect.try({
      try: () => env.LOADER.load(code),
      catch: (cause) => new ExecutionFailure({ cause }),
    });
    const response = yield* Effect.tryPromise({
      try: () => stub.getEntrypoint().fetch("https://execution/"),
      catch: (cause) => new ExecutionFailure({ cause }),
    });
    const data = yield* readBounded(response.body, session.head.policy.maxOutputBytes);
    if (!response.ok)
      return yield* new Fault({
        code: "EXECUTION_FAILED",
        status: 422,
        message: "Guest execution failed",
      });
    return yield* Schema.decodeUnknownEffect(Schema.fromJsonString(RunResult))(
      data.toString("utf8"),
    );
  }).pipe(Effect.result);
  const finishedAt = yield* Clock.currentTimeMillis;
  const finished = yield* Effect.sync(() => {
    if (output._tag === "Success")
      return { ...record, status: "exited" as const, finishedAt, output: output.success };
    console.error("Cirro guest failed", output.failure);
    return { ...record, status: "failed" as const, finishedAt, output: null };
  });
  const completed = yield* Effect.tryPromise({
    try: () =>
      env.OBJECTS.put(key, Schema.encodeSync(Schema.fromJsonString(RunRecord))(finished), {
        onlyIf: { etagMatches: receipt.etag },
        customMetadata: Schema.encodeSync(RunMetadata)({
          summary: Struct.omit(finished, ["output"]),
        }),
      }),
    catch: (cause) => new StorageFailure({ cause }),
  });
  if (completed === null)
    return yield* new Fault({
      code: "CONFLICT",
      status: 409,
      message: "Execution state changed; inspect process.get",
    });
  return finished;
});

export const inspect = Effect.fn("process.inspect")(function* (
  env: Env,
  capability: typeof Capability.Type,
  id: string,
) {
  yield* requirePermission(capability, "read");
  yield* open(env, capability.sandboxId);
  const object = yield* Effect.tryPromise({
    try: () => env.OBJECTS.get(`sandboxes/${capability.sandboxId}/runs/${id}.json`),
    catch: (cause) => new StorageFailure({ cause }),
  });
  if (object === null)
    return yield* new Fault({ code: "ENOENT", status: 404, message: "Execution does not exist" });
  const text = yield* Effect.tryPromise({
    try: () => object.text(),
    catch: (cause) => new StorageFailure({ cause }),
  });
  return yield* Schema.decodeUnknownEffect(Schema.fromJsonString(RunRecord))(text).pipe(
    Effect.mapError((cause) => new StorageFailure({ cause })),
  );
});

export const list = Effect.fn("process.list")(function* (
  env: Env,
  capability: typeof Capability.Type,
  action: typeof ProcessListAction.Type,
) {
  yield* requirePermission(capability, "read");
  yield* open(env, capability.sandboxId);
  const page = yield* Effect.tryPromise({
    try: () => {
      const options: R2ListOptions = {
        prefix: `sandboxes/${capability.sandboxId}/runs/`,
        limit: action.limit,
        include: ["customMetadata"],
      };
      if (action.cursor === null) return env.OBJECTS.list(options);
      return env.OBJECTS.list({ ...options, cursor: action.cursor });
    },
    catch: (cause) => new StorageFailure({ cause }),
  });
  const items = yield* Effect.forEach(page.objects, (object) =>
    Schema.decodeUnknownEffect(RunMetadata)(object.customMetadata).pipe(
      Effect.map((metadata) => metadata.summary),
    ),
  );
  if (page.truncated) return { items, cursor: page.cursor };
  return { items, cursor: null };
});
