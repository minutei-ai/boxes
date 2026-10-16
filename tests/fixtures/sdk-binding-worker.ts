import { Clock, Effect, Fiber, Latch, Redacted, Schedule, Schema } from "effect";
import { makeBinding } from "../../src/sdk";
import { makeAgentBinding } from "../../src/sdk-rpc";
import { BoxesContextCleanupError, createBoxesIsolateDriver } from "../../src/sdk-tanstack";
import type { AgentProtocol } from "../../src/rpc-protocol";
import {
  CronRecord,
  ContextRecord,
  FileContent,
  FileStat,
  Id,
  Policy,
  RunRecord,
  ReclamationProgress,
} from "../../src/contracts";

export const BindingProof = Schema.Struct({
  file: FileContent,
  stat: FileStat,
  restoredStat: FileStat,
  cron: CronRecord,
  run: RunRecord,
  rpc: RunRecord,
  hostCalls: Schema.Array(Schema.String),
  denied: Schema.Int,
  reclaimed: ReclamationProgress,
});
export const ContextBindingProof = Schema.Struct({
  records: Schema.Array(RunRecord),
  context: ContextRecord,
  errors: Schema.Array(Schema.String),
  calls: Schema.Int,
});
export const RpcProbe = Schema.Struct({
  record: Schema.NullOr(RunRecord),
  calls: Schema.Int,
  callbackCompleted: Schema.Boolean,
  denied: Schema.NullOr(Schema.Int),
});
export const DriverProof = Schema.Struct({
  scratch: FileContent,
  values: Schema.Array(Schema.Json),
  voidResult: Schema.Boolean,
  writes: Schema.Array(Schema.String),
  closed: Schema.Boolean,
});
export const PersistentDriverProof = Schema.Struct({
  file: FileContent,
  cancelled: Schema.Boolean,
  lateWrites: Schema.Array(Schema.String),
  lowMemoryRejected: Schema.Boolean,
  sandboxLimitEnforced: Schema.Boolean,
  allocation: Schema.Int,
  writeDenied: Schema.Boolean,
  sandboxMemoryBytes: Policy.fields.memoryBytes,
  callbacks: Schema.Array(Schema.String),
  foreignStatus: RunRecord.fields.status,
});
export const DriverAbortProof = Schema.Struct({
  preflight: Schema.String,
  cancelled: Schema.String,
  writes: Schema.Array(Schema.String),
});
export const DriverCleanupProof = Schema.Struct({
  failure: BoxesContextCleanupError,
  closed: Schema.Boolean,
});
const RpcCase = Schema.Literals([
  "hardlinks",
  "undefined",
  "disposal",
  "error",
  "timeout",
  "deadline",
  "credentials",
  "wrong-sandbox",
  "oversize",
  "queue",
]);
export default {
  fetch(
    request: Request,
    env: { BOXES: Fetcher; BOXES_AGENT: Fetcher<AgentProtocol>; TOKEN: string },
  ) {
    return Effect.runPromise(
      Effect.gen(function* () {
        const id = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Id))(
          yield* Effect.promise(() => request.text()),
        );
        const admin = yield* makeBinding(env.BOXES, Redacted.make(env.TOKEN));
        const policy = {
          networkHosts: [],
          interruptBudget: 1000,
          memoryBytes: 8388608,
          maxOutputBytes: 1048576,
        };
        const pythonPhase = new URL(request.url).searchParams.get("python_contexts");
        if (pythonPhase !== null) {
          const phase = yield* Schema.decodeUnknownEffect(Schema.Literals(["create", "read"]))(
            pythonPhase,
          );
          if (phase === "create") yield* admin.create({ id, policy });
          const permissions = yield* Effect.sync(() => {
            if (phase === "create") return ["read", "write", "execute"] as const;
            return ["read", "execute"] as const;
          });
          const grant = yield* admin.mintCapability(id, { permissions, expiresInSeconds: 600 });
          const agent = yield* makeAgentBinding(env.BOXES_AGENT, Redacted.make(grant.token));
          if (phase === "create") {
            yield* agent.action(id, { op: "contexts.create", id: "python", language: "python" });
            const record = yield* agent.action(id, {
              op: "python.execute",
              id: "python-seed",
              contextId: "python",
              filePath: "/seed.py",
              env: { MODE: "seed" },
              source:
                "import os\ndef factory():\n n=40\n def next():\n  nonlocal n\n  n+=1\n  return n\n return next\nnext_value=factory()\nasync def saved_write():\n return await tools.call({'op':'filesystem.writeFile','path':'/tmp/blocked','content':'denied','encoding':'utf8'})\nnext_value()",
            });
            return new Response(
              Schema.encodeSync(Schema.fromJsonString(ContextBindingProof))({
                records: [record],
                context: yield* agent.action(id, { op: "contexts.get", id: "python" }),
                errors: [],
                calls: 0,
              }),
            );
          }
          const next = yield* agent.action(id, {
            op: "python.evaluate",
            id: "python-resume",
            contextId: "python",
            env: { MODE: "current" },
            expression: "[next_value(),os.getenv('MODE'),next_value.__code__.co_filename]",
          });
          const denied = yield* agent.action(id, {
            op: "python.execute",
            id: "python-denied",
            contextId: "python",
            source:
              "try:\n await saved_write()\nexcept RuntimeError as error:\n denied=error.error\ndenied",
          });
          return new Response(
            Schema.encodeSync(Schema.fromJsonString(ContextBindingProof))({
              records: [next, denied],
              context: yield* agent.action(id, { op: "contexts.get", id: "python" }),
              errors: [],
              calls: 0,
            }),
          );
        }
        const contextPhase = new URL(request.url).searchParams.get("contexts");
        if (contextPhase !== null) {
          const phase = yield* Schema.decodeUnknownEffect(
            Schema.Literals(["create", "read", "concurrent", "timeout"]),
          )(contextPhase);
          if (phase !== "read") yield* admin.create({ id, policy });
          const grant = yield* admin.mintCapability(id, {
            permissions: ["read", "write", "execute"],
            expiresInSeconds: 600,
          });
          const agent = yield* makeAgentBinding(env.BOXES_AGENT, Redacted.make(grant.token));
          if (phase !== "read") yield* agent.action(id, { op: "contexts.create", id: "analysis" });
          const calls = { count: 0 };
          if (phase === "create") {
            const record = yield* agent.runWithTools(
              id,
              {
                contextId: "analysis",
                id: "seed",
                tools: ["echo"],
                maxToolCalls: 1,
                timeoutMs: 5000,
                source:
                  "export default async({tools})=>{globalThis.reuse=()=>tools.call({op:'host.call',name:'echo'});return globalThis.reuse();}",
              },
              async () => {
                calls.count += 1;
                return { ok: true, value: 11 };
              },
            );
            return new Response(
              Schema.encodeSync(Schema.fromJsonString(ContextBindingProof))({
                records: [record],
                context: yield* agent.action(id, { op: "contexts.get", id: "analysis" }),
                errors: [],
                calls: calls.count,
              }),
            );
          }
          if (phase === "read") {
            const record = yield* agent.runWithTools(
              id,
              {
                contextId: "analysis",
                id: "next",
                tools: ["echo"],
                maxToolCalls: 1,
                timeoutMs: 5000,
                source: "export default()=>globalThis.reuse();",
              },
              async () => {
                calls.count += 1;
                return { ok: true, value: 42 };
              },
            );
            const restricted = yield* agent.runWithTools(
              id,
              {
                contextId: "analysis",
                id: "restricted",
                tools: [],
                maxToolCalls: 1,
                timeoutMs: 5000,
                source: "export default()=>globalThis.reuse().catch(error=>error.code);",
              },
              async () => {
                calls.count += 1;
                return { ok: true, value: "forbidden-callback" };
              },
            );
            return new Response(
              Schema.encodeSync(Schema.fromJsonString(ContextBindingProof))({
                records: [record, restricted],
                context: yield* agent.action(id, { op: "contexts.get", id: "analysis" }),
                errors: [],
                calls: calls.count,
              }),
            );
          }
          if (phase === "timeout") {
            const completed = yield* Latch.make();
            const record = yield* agent.runWithTools(
              id,
              {
                contextId: "analysis",
                id: "timeout",
                tools: ["gate"],
                maxToolCalls: 1,
                timeoutMs: 1000,
                source: "export default({tools})=>tools.call({op:'host.call',name:'gate'});",
              },
              async () => {
                calls.count += 1;
                return Effect.runPromise(
                  Effect.sleep(1500).pipe(
                    Effect.andThen(completed.open),
                    Effect.as({ ok: true as const, value: "late" }),
                  ),
                );
              },
            );
            yield* completed.await;
            return new Response(
              Schema.encodeSync(Schema.fromJsonString(ContextBindingProof))({
                records: [record],
                context: yield* agent.action(id, { op: "contexts.get", id: "analysis" }),
                errors: [],
                calls: calls.count,
              }),
            );
          }
          return yield* Effect.scoped(
            Effect.gen(function* () {
              const entered = yield* Latch.make();
              const release = yield* Latch.make();
              const pending = yield* agent
                .runWithTools(
                  id,
                  {
                    contextId: "analysis",
                    id: "hold",
                    tools: ["gate"],
                    maxToolCalls: 1,
                    timeoutMs: 5000,
                    source: "export default({tools})=>tools.call({op:'host.call',name:'gate'});",
                  },
                  async () => {
                    calls.count += 1;
                    return Effect.runPromise(
                      entered.open.pipe(
                        Effect.andThen(release.await),
                        Effect.as({ ok: true as const, value: "released" }),
                      ),
                    );
                  },
                )
                .pipe(Effect.forkChild);
              yield* entered.await;
              const errors = yield* Effect.gen(function* () {
                const active = yield* agent.action(id, { op: "contexts.get", id: "analysis" });
                if (active.state !== "running")
                  return yield* Effect.die("Context lost active ownership");
                return yield* Effect.forEach(
                  [
                    { op: "contexts.reset", id: "analysis" },
                    { op: "contexts.delete", id: "analysis" },
                    {
                      op: "javascript.evaluate",
                      id: "competing",
                      expression: "1",
                      contextId: "analysis",
                    },
                  ] as const,
                  (action) =>
                    agent.action(id, action).pipe(
                      Effect.result,
                      Effect.flatMap((result) => {
                        if (result._tag === "Failure" && result.failure._tag === "BoxesError")
                          return Effect.succeed(result.failure.error);
                        return Effect.die("Concurrent context operation was admitted");
                      }),
                    ),
                );
              }).pipe(Effect.ensuring(release.open));
              const record = yield* Fiber.join(pending);
              return new Response(
                Schema.encodeSync(Schema.fromJsonString(ContextBindingProof))({
                  records: [record],
                  context: yield* agent.action(id, { op: "contexts.get", id: "analysis" }),
                  errors,
                  calls: calls.count,
                }),
              );
            }),
          );
        }
        const persistent = new URL(request.url).searchParams.get("persistent");
        if (persistent !== null) {
          const phase = yield* Schema.decodeUnknownEffect(Schema.Literals(["create", "read"]))(
            persistent,
          );
          if (phase === "create")
            yield* admin.create({ id, policy: { ...policy, memoryBytes: 33554432 } });
          const grant = yield* admin.mintCapability(id, {
            permissions: ["read", "write", "execute"],
            expiresInSeconds: 600,
          });
          const client = yield* makeBinding(env.BOXES, Redacted.make(grant.token));
          if (phase === "create")
            yield* client.action(id, {
              op: "process.spawn",
              execution: {
                op: "process.run",
                id: "foreign",
                language: "typescript",
                source: 'export default () => "foreign"',
              },
            });
          const driver = createBoxesIsolateDriver(env.BOXES_AGENT, {
            kind: "persistent",
            sandboxId: id,
            capabilityToken: Redacted.make(grant.token),
          });
          const waiting = yield* Latch.make();
          const release = yield* Latch.make();
          const lateWrites: string[] = [];
          const cancellation = yield* Effect.scoped(
            Effect.gen(function* () {
              const context = yield* Effect.acquireRelease(
                Effect.tryPromise(() =>
                  driver.createContext({
                    memoryLimit: 8,
                    timeout: 5000,
                    bindings: {
                      external_wait: {
                        name: "wait",
                        description: "Wait for scope closure",
                        inputSchema: {},
                        execute: () =>
                          Effect.runPromise(
                            Effect.gen(function* () {
                              yield* waiting.open;
                              yield* release.await;
                              return null;
                            }),
                          ),
                      },
                      external_save: {
                        name: "save",
                        description: "Record a late mutation",
                        inputSchema: {},
                        execute: async () => {
                          lateWrites.push("late");
                          return null;
                        },
                      },
                    },
                  }),
                ),
                (context) =>
                  Effect.promise(() => context.dispose()).pipe(Effect.ensuring(release.open)),
              );
              const running = yield* Effect.tryPromise(() =>
                context.execute("await external_wait(); return external_save();"),
              ).pipe(Effect.forkChild);
              yield* waiting.await;
              const closing = yield* Effect.sync(() => context.dispose());
              yield* release.open;
              yield* Effect.promise(() => closing);
              return yield* Fiber.join(running);
            }),
          );
          const callbacks: string[] = [];
          const invoke = Effect.fn("fixture.persistent.invoke")(
            (
              driver: ReturnType<typeof createBoxesIsolateDriver>,
              memoryLimit: number,
              source: string,
              label: string,
            ) =>
              Effect.acquireUseRelease(
                Effect.tryPromise(() =>
                  driver.createContext({
                    memoryLimit,
                    timeout: 5000,
                    bindings: {
                      external_label: {
                        name: "label",
                        description: "Caller-owned label",
                        inputSchema: {},
                        execute: async () => {
                          callbacks.push(label);
                          return label;
                        },
                      },
                    },
                  }),
                ),
                (context) => Effect.tryPromise(() => context.execute(source)),
                (context) => Effect.promise(() => context.dispose()),
              ),
          );
          if (phase === "create")
            yield* invoke(
              driver,
              8,
              'await tools.call({op:"filesystem.writeFile",path:"/tmp/shared",content:"confirmed",encoding:"utf8"});',
              "create",
            );
          const small = yield* invoke(
            driver,
            8,
            "await external_label(); return new Uint8Array(20000000).length;",
            `${phase}:small`,
          );
          const large = yield* invoke(
            driver,
            32,
            "await external_label(); return new Uint8Array(20000000).length;",
            `${phase}:large`,
          );
          const owner = yield* admin.mintCapability(id, {
            permissions: ["manage"],
            expiresInSeconds: 60,
          });
          const ownership = yield* makeBinding(env.BOXES, Redacted.make(owner.token));
          yield* ownership.action(id, { op: "config.patch", policy: { memoryBytes: 8388608 } });
          const capped = yield* invoke(
            driver,
            32,
            "return new Uint8Array(20000000).length;",
            "capped",
          );
          yield* ownership.action(id, { op: "config.patch", policy: { memoryBytes: 33554432 } });
          const readonly = yield* admin.mintCapability(id, {
            permissions: ["read", "execute"],
            expiresInSeconds: 600,
          });
          const readonlyDriver = createBoxesIsolateDriver(env.BOXES_AGENT, {
            kind: "persistent",
            sandboxId: id,
            capabilityToken: Redacted.make(readonly.token),
          });
          const denied = yield* invoke(
            readonlyDriver,
            8,
            'await tools.call({op:"filesystem.writeFile",path:"/tmp/shared",content:"forbidden",encoding:"utf8"});',
            "readonly",
          );
          const file = yield* client.action(id, { op: "filesystem.readFile", path: "/tmp/shared" });
          const status = yield* client.action(id, { op: "vm.status" });
          const foreign = yield* client.action(id, { op: "process.get", id: "foreign" });
          const proof = {
            file,
            cancelled: !cancellation.success,
            lateWrites,
            lowMemoryRejected: !small.success,
            sandboxLimitEnforced: !capped.success,
            allocation: yield* Schema.decodeUnknownEffect(Schema.Int)(large.value),
            writeDenied: !denied.success,
            sandboxMemoryBytes: status.policy.memoryBytes,
            callbacks,
            foreignStatus: foreign.status,
          };
          if (phase === "read") yield* ownership.action(id, { op: "vm.dispose" });
          return new Response(
            Schema.encodeSync(Schema.fromJsonString(PersistentDriverProof))(proof),
          );
        }
        yield* admin.create({ id, policy });
        const capability = yield* admin.mintCapability(id, {
          permissions: ["read", "write", "execute", "manage"],
          expiresInSeconds: 600,
        });
        const boxes = yield* makeBinding(env.BOXES, Redacted.make(capability.token));
        if (new URL(request.url).searchParams.has("driver")) {
          const driver = createBoxesIsolateDriver(env.BOXES_AGENT, {
            kind: "ephemeral",
            administratorToken: Redacted.make(env.TOKEN),
          });
          if (new URL(request.url).searchParams.get("driver") === "abort") {
            const stopped = yield* Effect.tryPromise({
              try: async () =>
                await driver.createContext({ abortSignal: AbortSignal.abort(), bindings: {} }),
              catch: (cause) => cause,
            }).pipe(Effect.result);
            if (stopped._tag !== "Failure")
              return yield* Effect.die("Cancelled context was acquired");
            const preflight = yield* Schema.decodeUnknownEffect(
              Schema.Struct({ name: Schema.String }),
            )(stopped.failure);
            const controller = new AbortController();
            const writes: string[] = [];
            const context = yield* Effect.tryPromise(() =>
              driver.createContext({
                memoryLimit: 16,
                timeout: 1000,
                abortSignal: controller.signal,
                bindings: {
                  external_save: {
                    name: "save",
                    description: "save",
                    inputSchema: {},
                    execute: async () => {
                      writes.push("confirmed");
                      return "confirmed";
                    },
                  },
                  external_wait: {
                    name: "wait",
                    description: "wait",
                    inputSchema: {},
                    execute: async () => {
                      controller.abort();
                      return Effect.runPromise(Effect.sleep("5 seconds"), {
                        signal: controller.signal,
                      });
                    },
                  },
                },
              }),
            );
            const result = yield* Effect.tryPromise(() =>
              context.execute(
                "await external_save({}); await external_wait({}); return external_save({});",
              ),
            );
            yield* Effect.tryPromise(() => context.dispose());
            yield* boxes.action(id, { op: "vm.dispose" });
            if (result.error === undefined) return yield* Effect.die("Abort result missing");
            return new Response(
              Schema.encodeSync(Schema.fromJsonString(DriverAbortProof))({
                preflight: preflight.name,
                cancelled: result.error.name,
                writes,
              }),
            );
          }
          if (new URL(request.url).searchParams.get("driver") === "blocked")
            return yield* Effect.scoped(
              Effect.gen(function* () {
                const context = yield* Effect.acquireRelease(
                  Effect.tryPromise(() => driver.createContext({ bindings: {} })),
                  (context) => Effect.promise(() => context.dispose()),
                );
                const spawned = yield* Effect.tryPromise(() =>
                  context.execute(
                    'return await tools.call({op:"process.spawn",execution:{op:"process.run",id:"pending-cleanup",language:"javascript",source:"export default () => 42;"}});',
                  ),
                );
                if (!spawned.success) return yield* Effect.die(spawned);
                const first = yield* Effect.tryPromise({
                  try: () => context.dispose(),
                  catch: (cause) => cause,
                }).pipe(Effect.result);
                if (first._tag !== "Failure")
                  return yield* Effect.die("Queued receipt did not block collection");
                const failure = yield* Schema.decodeUnknownEffect(BoxesContextCleanupError)(
                  first.failure,
                );
                yield* boxes.action(id, {
                  op: "filesystem.writeFile",
                  path: "/cleanup-blocked",
                  content: failure.sandboxId,
                  encoding: "utf8",
                });
                const closed = yield* Effect.tryPromise(() =>
                  context.execute(
                    'return tools.call({op:"filesystem.writeFile",path:"/late",content:"late",encoding:"utf8"});',
                  ),
                );
                yield* Effect.tryPromise({
                  try: () => context.dispose(),
                  catch: (cause) => cause,
                }).pipe(
                  Effect.retry({
                    while: Schema.is(BoxesContextCleanupError),
                    schedule: Schedule.spaced("10 millis"),
                    times: 200,
                  }),
                );
                yield* boxes.action(id, { op: "vm.dispose" });
                return new Response(
                  Schema.encodeSync(Schema.fromJsonString(DriverCleanupProof))({
                    failure,
                    closed: !closed.success,
                  }),
                );
              }),
            );
          if (new URL(request.url).searchParams.get("driver") === "bulk")
            return yield* Effect.scoped(
              Effect.gen(function* () {
                const context = yield* Effect.acquireRelease(
                  Effect.tryPromise(() =>
                    driver.createContext({ memoryLimit: 16, timeout: 10000, bindings: {} }),
                  ),
                  (context) => Effect.promise(() => context.dispose()),
                );
                const result = yield* Effect.tryPromise(() =>
                  context.execute(
                    'for (let batch = 0; batch < 8; batch++) { const entries = Array.from({length:128}, (_, offset) => ({path:`/tmp/gc-${batch*128+offset}`,content:`payload-${batch*128+offset}`,encoding:"utf8"})); const writes = await tools.call({op:"filesystem.writeFiles",entries}); if (writes.some(write => !write.success)) return -1; } return (await tools.call({op:"filesystem.readdir",path:"/tmp"})).length;',
                  ),
                );
                yield* Effect.tryPromise(() => Promise.all([context.dispose(), context.dispose()]));
                yield* Effect.tryPromise(() => context.dispose());
                yield* boxes.action(id, { op: "vm.dispose" });
                return new Response(
                  Schema.encodeSync(Schema.fromJsonString(Schema.Int))(
                    Schema.decodeUnknownSync(Schema.Int)(result.value),
                  ),
                );
              }),
            );
          const writes: string[] = [];
          const context = yield* Effect.tryPromise(() =>
            driver.createContext({
              memoryLimit: 16,
              timeout: 1000,
              bindings: {
                external_save: {
                  name: "save",
                  description: "save",
                  inputSchema: {},
                  execute: async (input) => {
                    const value = Schema.decodeUnknownSync(Schema.String)(input);
                    writes.push(value);
                    return value;
                  },
                },
                external_void: {
                  name: "void",
                  description: "void",
                  inputSchema: {},
                  execute: async () => undefined,
                },
              },
            }),
          );
          const first = yield* Effect.tryPromise(() =>
            context.execute(
              'const value = await external_save("confirmed"); console.log(value); return value;',
            ),
          );
          const second = yield* Effect.tryPromise(() =>
            context.execute("return (await external_void()) === undefined;"),
          );
          const scratch = yield* Effect.tryPromise(() =>
            context.execute(
              'await tools.call({op:"filesystem.writeFile",path:"/tmp/work",content:"a\\nb\\n",encoding:"utf8"}); await tools.call({op:"process.run",id:"filter",language:"shell",source:"wc -l < /tmp/work > /tmp/count"}); return await tools.call({op:"filesystem.readFile",path:"/tmp/count"});',
            ),
          );
          const empty = yield* Effect.tryPromise(() => context.execute("await external_void();"));
          yield* Effect.tryPromise(() => Promise.all([context.dispose(), context.dispose()]));
          yield* Effect.tryPromise(() => context.dispose());
          const closed = yield* Effect.tryPromise(() =>
            context.execute('return external_save("late");'),
          );
          yield* boxes.action(id, { op: "vm.dispose" });
          return new Response(
            Schema.encodeSync(Schema.fromJsonString(DriverProof))({
              scratch: Schema.decodeUnknownSync(FileContent)(scratch.value),
              values: [
                Schema.decodeUnknownSync(Schema.Json)(first.value),
                Schema.decodeUnknownSync(Schema.Json)(second.value),
              ],
              voidResult: empty.success && empty.value === undefined,
              writes,
              closed: !closed.success,
            }),
          );
        }
        const rpcCase = new URL(request.url).searchParams.get("rpc");
        if (rpcCase !== null) {
          const mode = yield* Schema.decodeUnknownEffect(RpcCase)(rpcCase);
          const token = yield* Effect.sync(() => {
            if (mode === "credentials") return Redacted.make("invalid");
            return Redacted.make(capability.token);
          });
          const agent = yield* makeAgentBinding(env.BOXES_AGENT, token);
          const calls = { count: 0 };
          const completion = { done: false };
          const callbackCompleted = yield* Latch.make();
          const input = {
            id: "rpc-probe",
            tools: ["lookup"],
            maxToolCalls: 1,
            timeoutMs: 1000,
            source:
              'export default async ({tools}) => tools.call({op:"host.call",name:"lookup",input:{}}).catch(error => error.code)',
          };
          if (mode === "hardlinks") {
            input.maxToolCalls = 8;
            input.source =
              'export default async ({tools}) => { await tools.call({op:"filesystem.writeFile",path:"/tmp/source",content:"old",encoding:"utf8"}); await tools.call({op:"filesystem.link",from:"/tmp/source",to:"/tmp/alias",follow:false}); await tools.call({op:"filesystem.writeFile",path:"/tmp/alias",content:"binding",encoding:"utf8"}); const a = await tools.call({op:"filesystem.stat",path:"/tmp/source",follow:true}); const b = await tools.call({op:"filesystem.stat",path:"/tmp/alias",follow:true}); const file = await tools.call({op:"filesystem.readFile",path:"/tmp/source"}); return {same:a.inode===b.inode,links:a.nlink,content:file.content,callback:await tools.call({op:"host.call",name:"lookup",input:{}})}; }';
          }
          if (mode === "timeout") input.timeoutMs = 1000;
          if (mode === "deadline") input.timeoutMs = 5000;
          if (mode === "undefined")
            input.source =
              'export default async ({tools}) => (await tools.call({op:"host.call",name:"lookup"})) === undefined';
          if (mode === "disposal") {
            input.maxToolCalls = 2;
            input.source =
              'export default async ({tools}) => { await tools.call({op:"host.call",name:"lookup",input:{}}); return tools.call({op:"host.call",name:"lookup",input:{}}).catch(error => error.code); }';
          }
          const result = yield* Effect.gen(function* () {
            if (mode === "queue")
              return yield* boxes.action(id, {
                op: "process.spawn",
                execution: {
                  op: "process.run",
                  id: "rpc-probe",
                  language: "typescript",
                  source: input.source,
                },
              });
            const sandbox = yield* Effect.sync(() => {
              if (mode === "wrong-sandbox") return `${id}-other`;
              return id;
            });
            return yield* agent.runWithTools(sandbox, input, async (call) => {
              calls.count += 1;
              if (mode === "undefined") {
                if (call.input !== undefined)
                  return { ok: false, message: "Undefined input changed" };
                return { ok: true, value: undefined };
              }
              if (mode === "disposal") {
                await Effect.runPromise(boxes.action(id, { op: "vm.dispose" }));
                return { ok: true, value: "disposed" };
              }
              if (mode === "error") return { ok: false, message: "declared callback failure" };
              if (mode === "deadline") {
                const record = await Effect.runPromise(
                  boxes.action(id, { op: "process.get", id: input.id }),
                );
                const recovery = await Effect.runPromise(
                  boxes.action(id, { op: "process.recovery.status", id: input.id }),
                );
                return {
                  ok: true,
                  value: recovery.deadlineAt === record.startedAt + input.timeoutMs,
                };
              }
              if (mode === "timeout")
                return Effect.runPromise(
                  Effect.sleep(input.timeoutMs + 100).pipe(
                    Effect.tap(() =>
                      Effect.sync(() => {
                        completion.done = true;
                      }),
                    ),
                    Effect.tap(() => callbackCompleted.open),
                    Effect.as({ ok: true as const, value: "late" }),
                  ),
                );
              if (mode === "oversize") return { ok: true, value: "x".repeat(1_048_576) };
              return { ok: true, value: "callback" };
            });
          }).pipe(Effect.result);
          if (mode === "timeout" && calls.count > 0) yield* callbackCompleted.await;
          if (result._tag === "Failure") {
            if (result.failure._tag !== "BoxesError") return yield* result.failure;
            yield* boxes.action(id, { op: "vm.dispose" });
            return new Response(
              Schema.encodeSync(Schema.fromJsonString(RpcProbe))({
                record: null,
                calls: calls.count,
                callbackCompleted: completion.done,
                denied: result.failure.status,
              }),
            );
          }
          if (mode !== "queue" && mode !== "disposal")
            yield* boxes.action(id, { op: "vm.dispose" });
          return new Response(
            Schema.encodeSync(Schema.fromJsonString(RpcProbe))({
              record: result.success,
              calls: calls.count,
              callbackCompleted: completion.done,
              denied: null,
            }),
          );
        }
        yield* boxes.action(id, {
          op: "config.patch",
          policy: {},
          environment: { BOXES_BINDING_MARKER: "configured" },
        });
        const environment = yield* boxes.action(id, { op: "config.get" });
        if (environment.environment.BOXES_BINDING_MARKER !== "configured")
          return yield* Effect.die("Binding configuration environment differs");
        const environmentRun = yield* boxes.action(id, {
          op: "typescript.evaluate",
          id: "binding-configured-environment",
          expression: "[process.env.BOXES_BINDING_MARKER, typeof process.binding]",
          env: { BOXES_BINDING_MARKER: "caller" },
        });
        yield* Schema.decodeUnknownEffect(
          Schema.Tuple([Schema.Literal("caller"), Schema.Literal("undefined")]),
        )(environmentRun.output?.result);
        const shellEnvironment = yield* boxes.action(id, {
          op: "process.run",
          id: "binding-shell-parameters",
          language: "shell",
          source: 'false; true | echo "$?" "$BOXES_BINDING_MARKER"',
        });
        if (shellEnvironment.output?.stdout !== "1 configured\n")
          return yield* Effect.die("Binding shell parameter expansion differs");
        const environmentRpc = yield* makeAgentBinding(
          env.BOXES_AGENT,
          Redacted.make(capability.token),
        );
        const shellVariables = yield* environmentRpc.action(id, {
          op: "process.run",
          id: "binding-shell-variables",
          language: "shell",
          source:
            'LOCAL=bound; export LOCAL; LOCAL=temporary echo "$LOCAL" "$BOXES_BINDING_MARKER"; unset LOCAL; echo "[$LOCAL]"; readonly FIXED=bound; echo "$FIXED"; FIXED=changed; echo unreachable',
        });
        if (
          shellVariables.output?.stdout !== "bound configured\n[]\nbound\n" ||
          shellVariables.output.exitCode !== 2 ||
          !shellVariables.output.stderr.includes("readonly")
        )
          return yield* Effect.die("Agent binding shell variable scope differs");
        const rpcEnvironment = yield* environmentRpc.runWithTools(
          id,
          {
            id: "binding-rpc-environment",
            tools: [],
            maxToolCalls: 1,
            timeoutMs: 1000,
            source: "export default () => process.env.BOXES_BINDING_MARKER",
          },
          async () => ({ ok: false, message: "No callback granted" }),
        );
        if (rpcEnvironment.output?.result !== "configured")
          return yield* Effect.die("Agent binding lost sandbox environment");
        yield* boxes.action(id, {
          op: "filesystem.writeFile",
          path: "/binding",
          content: "native binding",
          encoding: "utf8",
        });
        const file = yield* boxes.action(id, { op: "filesystem.readFile", path: "/binding" });
        yield* boxes.action(id, {
          op: "filesystem.utimes",
          path: "/binding",
          atimeNs: 9007199254740993n,
          mtimeNs: 18446744073709551615n,
          follow: true,
        });
        const stat = yield* boxes.action(id, {
          op: "filesystem.stat",
          path: "/binding",
          follow: true,
        });
        const snapshot = yield* boxes.action(id, {
          op: "filesystem.export",
          maxBytes: 1048576,
        });
        yield* boxes.action(id, {
          op: "filesystem.writeFile",
          path: "/binding",
          content: "changed",
          encoding: "utf8",
        });
        yield* boxes.action(id, { op: "filesystem.restore", snapshot });
        const restoredStat = yield* boxes.action(id, {
          op: "filesystem.stat",
          path: "/binding",
          follow: true,
        });
        const restoredFile = yield* boxes.action(id, {
          op: "filesystem.readFile",
          path: "/binding",
        });
        if (restoredFile.content !== file.content)
          return yield* Effect.die("Restore lost file bytes");
        const invalidEnvironment = yield* boxes
          .action(id, {
            op: "process.run",
            id: "binding-environment",
            language: "wasm",
            source: "AGFzbQEAAAA=",
            env: { MARKER: "é".repeat(4096) },
          })
          .pipe(Effect.flip);
        if (
          invalidEnvironment._tag !== "BoxesError" ||
          invalidEnvironment.status !== 400 ||
          invalidEnvironment.error !== "EINVAL"
        )
          return yield* Effect.die("Binding accepted an oversized UTF-8 environment value");
        const stderrRun = yield* boxes.action(id, {
          op: "process.run",
          id: "binding-stderr",
          language: "shell",
          source: "head -n invalid 2> /tmp/binding-errors; head -n invalid 2>> /tmp/binding-errors",
        });
        const stderrFile = yield* boxes.action(id, {
          op: "filesystem.readFile",
          path: "/tmp/binding-errors",
        });
        if (
          stderrRun.output?.exitCode !== 2 ||
          stderrRun.output.stderr !== "" ||
          Buffer.from(stderrFile.content, stderrFile.encoding).toString() !==
            "invalid filter count\ninvalid filter count\n"
        )
          return yield* Effect.die("Binding stderr redirection differs");
        const run = yield* boxes.action(id, {
          op: "typescript.evaluate",
          id: "binding-run",
          expression: "6 * 7",
        });
        const denied = yield* boxes.create({ id: `${id}-denied`, policy }).pipe(Effect.flip);
        if (denied._tag !== "BoxesError") return yield* Effect.die(denied);
        const now = yield* Clock.currentTimeMillis;
        const cron = yield* boxes.action(id, {
          op: "cron.schedule",
          id: "binding-cron",
          schedule: new Date(now + 120000).toISOString(),
          overlap: "allow",
          execution: { op: "typescript.evaluate", id: "seed", expression: "6 * 7" },
        });
        yield* boxes.action(id, { op: "cron.cancel", id: cron.id });
        const agent = yield* makeAgentBinding(env.BOXES_AGENT, Redacted.make(capability.token));
        const hostCalls: string[] = [];
        const rpc = yield* agent.runWithTools(
          id,
          {
            id: "rpc-run",
            tools: ["lookup"],
            maxToolCalls: 2,
            timeoutMs: 1000,
            source:
              'export default async ({tools}) => { const a = await tools.call({op:"host.call",name:"lookup",input:{id:1}}); const b = await tools.call({op:"host.call",name:"lookup",input:{id:2}}); const failures = []; for (const name of ["lookup", "forbidden"]) { try { await tools.call({op:"host.call",name,input:{}}); } catch (error) { failures.push(error.code); } } return { a, b, failures }; }',
          },
          async (call) => {
            hostCalls.push(call.name);
            if (call.input === undefined) return { ok: true, value: undefined };
            return { ok: true, value: { echoed: call.input, actor: id } };
          },
        );
        yield* boxes.action(id, { op: "vm.dispose" });
        const reclamation: (typeof ReclamationProgress.Type)[] = [];
        for (const _ of Array.from({ length: 32 })) {
          const step = yield* boxes.action(id, { op: "vm.reclaim", limit: 1000 });
          reclamation.push(step);
          if (step.status === "complete") break;
        }
        const reclaimed = reclamation.at(-1);
        if (reclaimed === undefined || reclaimed.status !== "complete")
          return yield* Effect.die("Binding reclamation did not complete");
        return new Response(
          Schema.encodeSync(Schema.fromJsonString(BindingProof))({
            file,
            stat,
            restoredStat,
            cron,
            run,
            rpc,
            hostCalls,
            denied: denied.status,
            reclaimed,
          }),
          {
            headers: { "content-type": "application/json" },
          },
        );
      }),
    );
  },
};
