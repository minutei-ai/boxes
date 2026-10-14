import { Clock, Effect, Redacted, Schema } from "effect";
import { makeBinding } from "../../src/sdk";
import { makeAgentBinding } from "../../src/sdk-rpc";
import type { AgentProtocol } from "../../src/rpc-protocol";
import { CronRecord, FileContent, FileStat, Id, RunRecord } from "../../src/contracts";

export const BindingProof = Schema.Struct({
  file: FileContent,
  stat: FileStat,
  restoredStat: FileStat,
  cron: CronRecord,
  run: RunRecord,
  rpc: RunRecord,
  hostCalls: Schema.Array(Schema.String),
  denied: Schema.Int,
});
export const RpcProbe = Schema.Struct({
  record: Schema.NullOr(RunRecord),
  calls: Schema.Int,
  denied: Schema.NullOr(Schema.Int),
});
const RpcCase = Schema.Literals([
  "undefined",
  "disposal",
  "error",
  "timeout",
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
        yield* admin.create({ id, policy });
        const capability = yield* admin.mintCapability(id, {
          permissions: ["read", "write", "execute", "manage"],
          expiresInSeconds: 600,
        });
        const boxes = yield* makeBinding(env.BOXES, Redacted.make(capability.token));
        const rpcCase = new URL(request.url).searchParams.get("rpc");
        if (rpcCase !== null) {
          const mode = yield* Schema.decodeUnknownEffect(RpcCase)(rpcCase);
          const token = yield* Effect.sync(() => {
            if (mode === "credentials") return Redacted.make("invalid");
            return Redacted.make(capability.token);
          });
          const agent = yield* makeAgentBinding(env.BOXES_AGENT, token);
          const calls = { count: 0 };
          const input = {
            id: "rpc-probe",
            tools: ["lookup"],
            maxToolCalls: 1,
            timeoutMs: 1000,
            source:
              'export default async ({tools}) => tools.call({op:"host.call",name:"lookup",input:{}}).catch(error => error.code)',
          };
          if (mode === "timeout") input.timeoutMs = 25;
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
              if (mode === "timeout")
                return Effect.runPromise(
                  Effect.sleep(100).pipe(Effect.as({ ok: true as const, value: "late" })),
                );
              if (mode === "oversize") return { ok: true, value: "x".repeat(1_048_576) };
              return { ok: true, value: "callback" };
            });
          }).pipe(Effect.result);
          if (result._tag === "Failure") {
            if (result.failure._tag !== "BoxesError") return yield* result.failure;
            yield* boxes.action(id, { op: "vm.dispose" });
            return new Response(
              Schema.encodeSync(Schema.fromJsonString(RpcProbe))({
                record: null,
                calls: calls.count,
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
              denied: null,
            }),
          );
        }
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
          }),
          {
            headers: { "content-type": "application/json" },
          },
        );
      }),
    );
  },
};
