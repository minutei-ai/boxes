import { Effect, Redacted, Schema, Struct } from "effect";
import { makeAgentBinding } from "../../src/sdk-rpc";
import { createBoxesIsolateDriver } from "../../src/sdk-tanstack";
import { AgentRequest, ContextRecord, RunRecord } from "../../src/contracts";
import type { AgentProtocol } from "../../src/rpc-protocol";

export const RetainedBindingInput = Schema.Struct({
  ...AgentRequest.mapFields((fields) => Struct.pick(fields, ["sandboxId", "token"])).fields,
  phase: Schema.Literals(["create", "resume"]),
});
export const RetainedBindingProof = Schema.Struct({
  phase: RetainedBindingInput.fields.phase,
  context: ContextRecord,
  records: Schema.Array(RunRecord),
  callbacks: Schema.Int,
  deleted: Schema.Boolean,
  driver: Schema.Struct({ value: Schema.Json, closedDenied: Schema.Boolean }),
  python: Schema.Struct({
    context: ContextRecord,
    records: Schema.Array(RunRecord),
    deleted: Schema.Boolean,
  }),
});
export const VerifiedRetainedBindingProof = RetainedBindingProof.check(
  Schema.makeFilter((proof) => {
    if (
      !proof.driver.closedDenied ||
      proof.callbacks !== 1 ||
      proof.context.state !== "idle" ||
      proof.python.context.language !== "python" ||
      proof.python.context.state !== "idle" ||
      proof.python.records.some(
        (record) => record.status !== "exited" || record.output?.exitCode !== 0,
      ) ||
      proof.records.some((record) => record.status !== "exited" || record.output?.exitCode !== 0)
    )
      return `Retained execution did not complete: ${Schema.encodeSync(Schema.fromJsonString(RetainedBindingProof))(proof)}`;
    if (proof.phase === "create")
      return (
        (proof.driver.value === 41 &&
          proof.python.records.length === 2 &&
          proof.python.records[0]?.output?.result === null &&
          Schema.is(
            Schema.Tuple([
              Schema.Literal(41),
              Schema.Literal(41),
              Schema.Literal(42),
              Schema.Literal("café"),
              Schema.Literal("ação"),
            ]),
          )(proof.python.records[1]?.output?.result) &&
          !proof.python.deleted &&
          proof.python.context.generation === 0 &&
          !proof.deleted &&
          proof.context.generation === 0 &&
          proof.records.length === 2 &&
          Schema.is(Schema.Struct({ counter: Schema.Literal(41), tool: Schema.Literal(11) }))(
            proof.records[1]?.output?.result,
          )) ||
        `Retained creation differs: ${Schema.encodeSync(Schema.fromJsonString(RetainedBindingProof))(proof)}`
      );
    return (
      (proof.driver.value === 42 &&
        proof.python.records.length === 3 &&
        Schema.is(
          Schema.Tuple([
            Schema.Literal(42),
            Schema.Literal("current"),
            Schema.Literal("c2VlZA=="),
            Schema.Tuple([
              Schema.Struct({ value: Schema.Literal(42), text: Schema.Literal("ação") }),
              Schema.Tuple([Schema.Literal("box"), Schema.Literal("native")]),
              Schema.Literal(1),
              Schema.Literal(42),
              Schema.Literal(2),
            ]),
            Schema.Literal(false),
            Schema.Literal(42),
            Schema.Literal(42),
            Schema.Literal("café"),
            Schema.Literal("ação"),
            Schema.Literal(true),
          ]),
        )(proof.python.records[0]?.output?.result) &&
        Schema.is(
          Schema.Tuple([
            Schema.Literal("FORBIDDEN"),
            Schema.Literal("FORBIDDEN"),
            Schema.Literal("c2VlZA=="),
            Schema.Literal("c2VlZA=="),
          ]),
        )(proof.python.records[1]?.output?.result) &&
        proof.python.records[2]?.output?.result === false &&
        proof.python.deleted &&
        proof.python.context.generation === 1 &&
        proof.deleted &&
        proof.context.generation === 1 &&
        proof.records.length === 3 &&
        Schema.is(Schema.Struct({ counter: Schema.Literal(42), tool: Schema.Literal(42) }))(
          proof.records[0]?.output?.result,
        ) &&
        proof.records[0]?.output?.stdout === "resumed\n" &&
        proof.records[1]?.output?.result === "FORBIDDEN" &&
        proof.records[2]?.output?.result === "undefined") ||
      `Retained recovery differs: ${Schema.encodeSync(Schema.fromJsonString(RetainedBindingProof))(proof)}`
    );
  }),
);

export const retainedBindingProof = Effect.fn("fixture.retainedBindingProof")(function* (
  request: Request,
  binding: Fetcher<AgentProtocol>,
) {
  const input = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(RetainedBindingInput), {
    onExcessProperty: "error",
  })(yield* Effect.promise(() => request.text()));
  const client = yield* makeAgentBinding(binding, Redacted.make(input.token));
  const python = yield* Effect.gen(function* () {
    if (input.phase === "create") {
      yield* client.action(input.sandboxId, {
        op: "filesystem.mkdir",
        path: "/tmp/python_pkg",
        recursive: true,
      });
      for (const [path, content] of [
        ["/tmp/python_pkg/__init__.py", "from .leaf import answer\n"],
        ["/tmp/python_pkg/leaf.py", "answer=42\n"],
        [
          "/tmp/python_counter.py",
          "import _boxes_io\nsaved_call=_boxes_io.call\nsaved_call({'op':'filesystem.writeFile','path':'/tmp/python-module-grant','content':'seed','encoding':'utf8'})\nvalue=40\nlabel='ação'\ndef next():\n global value\n value+=1\n return value\ndef write():\n return saved_call({'op':'filesystem.writeFile','path':'/tmp/python-module-grant','content':'bad','encoding':'utf8'})\n",
        ],
      ] as const)
        yield* client.action(input.sandboxId, {
          op: "filesystem.writeFile",
          path,
          content,
          encoding: "utf8",
        });
      yield* client.action(input.sandboxId, {
        op: "filesystem.writeFile",
        path: "/tmp/python_latin.py",
        encoding: "base64",
        content: "IyBjb2Rpbmc6IGxhdGluLTEKbGFiZWw9J2NhZuknCg==",
      });
      yield* client.action(input.sandboxId, {
        op: "contexts.create",
        id: "retained-python",
        language: "python",
      });
      const defined = yield* client.action(input.sandboxId, {
        op: "python.execute",
        id: "python-seed",
        contextId: "retained-python",
        env: { MODE: "seed" },
        source:
          "import os, json, re, functools\nfrom collections import Counter\nfrom _thread import RLock\nimport python_counter,python_pkg,python_latin\nsaved_lock=RLock()\nassert not hasattr(saved_lock.acquire,'__code__')\nsaved_lock.acquire()\nsaved_lock.acquire()\ncounts=Counter('boxes')\n@functools.lru_cache(maxsize=8)\ndef cached(value):\n return value*2\nencoded=json.dumps({'value':cached(21),'text':'ação'},ensure_ascii=False)\ndef factory():\n n=40\n def next():\n  nonlocal n\n  n+=1\n  return n\n return next\nnext_value=factory()\nasync def saved_write(value):\n return await tools.call({'op':'filesystem.writeFile','path':'/tmp/python-grant','content':value,'encoding':'utf8'})\nawait saved_write('seed')\nfrom io import FileIO\nimport io,heapq,copy,contextlib\nassert FileIO is io.FileIO is __import__('_io').FileIO\nretained_writer=open('/tmp/python-orphan','w+b')\nretained_writer.write(b'seed')\nretained_writer.flush()\nretained_reader=os.open('/tmp/python-orphan',os.O_RDONLY)\nawait tools.call({'op':'filesystem.remove','path':'/tmp/python-orphan','recursive':False})\nretained_writer.seek(0)\nretained_writer.write(b'XY')\nretained_writer.flush()\nassert os.read(retained_reader,2)==b'XY'\nretained_heap=[3,1,2]\nheapq.heapify(retained_heap)\ncycle=[]\ncycle.append(cycle)\nretained_copy=copy.deepcopy(cycle)\nretained_stack=contextlib.ExitStack()\nretained_events=[]\nretained_stack.callback(retained_events.append,'closed')\ndef from_library():\n return [json.loads(encoded),re.findall(r'[a-z]+','box 42 native'),counts['b'],cached(21),saved_lock._recursion_count()]",
      });
      const record = yield* client.action(input.sandboxId, {
        op: "python.evaluate",
        id: "python-initial-value",
        contextId: "retained-python",
        expression:
          "[next_value(),python_counter.next(),python_pkg.answer,python_latin.label,python_counter.label]",
      });
      return {
        context: yield* client.action(input.sandboxId, {
          op: "contexts.get",
          id: "retained-python",
        }),
        records: [defined, record],
        deleted: false,
      };
    }
    const next = yield* client.action(input.sandboxId, {
      op: "python.execute",
      id: "python-resume",
      contextId: "retained-python",
      env: { MODE: "current" },
      source:
        "assert os.read(retained_reader,8)==b'ed'\nassert os.fstat(retained_reader).st_nlink==0\nassert not (await tools.call({'op':'filesystem.exists','path':'/tmp/python-orphan'}))['exists']\ntry:\n os.write(retained_writer.fileno(),b'bad')\nexcept PermissionError as error:\n assert error.errno==13\nelse:\n raise AssertionError('read-only orphan write succeeded')\nretained_writer.close()\nos.close(retained_reader)\nassert heapq.heappop(retained_heap)==1\nassert retained_copy[0] is retained_copy\nretained_stack.close()\nassert retained_events==['closed']\nassert Counter('aaabbc').most_common(2)==[('a',3),('b',2)]\nprior=from_library()\nsaved_lock.release()\nsaved_lock.release()\ncontent=await tools.call({'op':'filesystem.readFile','path':'/tmp/python-grant'})\nimport python_counter\n[next_value(),os.getenv('MODE'),content['content'],prior,saved_lock.locked(),python_counter.next(),python_pkg.answer,python_latin.label,python_counter.label,__import__('python_counter') is python_counter]",
    });
    const denied = yield* client.action(input.sandboxId, {
      op: "python.execute",
      id: "python-denied",
      contextId: "retained-python",
      source:
        "try:\n await saved_write('bad')\nexcept RuntimeError as error:\n denied=error.error\ntry:\n python_counter.write()\nexcept PermissionError as error:\n module_denied=error.error\ncurrent=await tools.call({'op':'filesystem.readFile','path':'/tmp/python-grant'})\nmodule_current=await tools.call({'op':'filesystem.readFile','path':'/tmp/python-module-grant'})\n[denied,module_denied,current['content'],module_current['content']]",
    });
    yield* client.action(input.sandboxId, { op: "contexts.reset", id: "retained-python" });
    const cleared = yield* client.action(input.sandboxId, {
      op: "python.evaluate",
      id: "python-cleared",
      contextId: "retained-python",
      expression: "'next_value' in globals()",
    });
    const context = yield* client.action(input.sandboxId, {
      op: "contexts.get",
      id: "retained-python",
    });
    const deleted = yield* client.action(input.sandboxId, {
      op: "contexts.delete",
      id: "retained-python",
    });
    return { context, records: [next, denied, cleared], deleted: deleted.ok };
  });
  const callbacks = { count: 0 };
  if (input.phase === "create")
    yield* client.action(input.sandboxId, { op: "contexts.create", id: "retained-driver" });
  const isolate = createBoxesIsolateDriver(binding, {
    kind: "persistent",
    sandboxId: input.sandboxId,
    capabilityToken: Redacted.make(input.token),
    contextId: "retained-driver",
  });
  const driver = yield* Effect.scoped(
    Effect.gen(function* () {
      const context = yield* Effect.acquireRelease(
        Effect.tryPromise(() =>
          isolate.createContext({ memoryLimit: 8, timeout: 30000, bindings: {} }),
        ),
        (context) => Effect.promise(() => context.dispose()),
      );
      const code = yield* Effect.sync(() => {
        if (input.phase === "create")
          return "let n=40;globalThis.driverNext=()=>++n;return globalThis.driverNext();";
        return "return globalThis.driverNext();";
      });
      const result = yield* Effect.tryPromise(() => context.execute(code));
      if (!result.success) return yield* Effect.die(result);
      const value = yield* Schema.decodeUnknownEffect(Schema.Json)(result.value);
      yield* Effect.promise(() => context.dispose());
      const closed = yield* Effect.tryPromise(() => context.execute("return 0;"));
      return { value, closedDenied: !closed.success };
    }),
  );
  if (input.phase === "create") {
    yield* client.action(input.sandboxId, { op: "contexts.create", id: "retained" });
    const seed = yield* client.action(input.sandboxId, {
      op: "javascript.execute",
      contextId: "retained",
      id: "retained-seed",
      source: "let n=40;globalThis.next=()=>++n;globalThis.log=console.log;",
    });
    const record = yield* client.runWithTools(
      input.sandboxId,
      {
        contextId: "retained",
        id: "retained-first",
        tools: ["lookup"],
        maxToolCalls: 1,
        timeoutMs: 30000,
        source:
          "export default async({tools})=>{globalThis.savedTool=()=>tools.call({op:'host.call',name:'lookup'});return{counter:globalThis.next(),tool:await globalThis.savedTool()};}",
      },
      async () => {
        callbacks.count += 1;
        return { ok: true, value: 11 };
      },
    );
    return yield* Schema.decodeUnknownEffect(VerifiedRetainedBindingProof)({
      phase: input.phase,
      records: [seed, record],
      context: yield* client.action(input.sandboxId, { op: "contexts.get", id: "retained" }),
      callbacks: callbacks.count,
      deleted: false,
      driver,
      python,
    });
  }
  const record = yield* client.runWithTools(
    input.sandboxId,
    {
      contextId: "retained",
      id: "retained-next",
      tools: ["lookup"],
      maxToolCalls: 1,
      timeoutMs: 30000,
      source:
        "export default async()=>{globalThis.log('resumed');return{counter:globalThis.next(),tool:await globalThis.savedTool()};}",
    },
    async () => {
      callbacks.count += 1;
      return { ok: true, value: 42 };
    },
  );
  const denied = yield* client.runWithTools(
    input.sandboxId,
    {
      contextId: "retained",
      id: "retained-denied",
      tools: [],
      maxToolCalls: 1,
      timeoutMs: 30000,
      source: "export default()=>globalThis.savedTool().catch(error=>error.code);",
    },
    async () => {
      callbacks.count += 1;
      return { ok: true, value: "forbidden" };
    },
  );
  yield* client.action(input.sandboxId, { op: "contexts.reset", id: "retained" });
  const cleared = yield* client.action(input.sandboxId, {
    op: "javascript.evaluate",
    contextId: "retained",
    id: "retained-cleared",
    expression: "typeof globalThis.next",
  });
  const context = yield* client.action(input.sandboxId, { op: "contexts.get", id: "retained" });
  const deleted = yield* client.action(input.sandboxId, { op: "contexts.delete", id: "retained" });
  return yield* Schema.decodeUnknownEffect(VerifiedRetainedBindingProof)({
    phase: input.phase,
    records: [record, denied, cleared],
    context,
    callbacks: callbacks.count,
    deleted: deleted.ok,
    driver,
    python,
  });
});
