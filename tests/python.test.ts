import { expect, test } from "bun:test";
import { Effect, Schema } from "effect";
import { join } from "node:path";
import { createBindings } from "../dist/python/bindings";
import { RunResult } from "../src/contracts";

const module = new WebAssembly.Module(
  await Bun.file(join(import.meta.dir, "../dist/python/cirro_python_bg.wasm")).arrayBuffer(),
);
const Completed = Schema.Struct({
  kind: Schema.Literal("done"),
  output: Schema.fromJsonString(RunResult),
});

test("compiled Python ABI meters user instructions after bounded bootstrap and releases interrupted instances", () => {
  const bindings = createBindings();
  const native = bindings.initSync({ module });
  native.__cirro_limits(100_000_000n, 512);
  const guest = new bindings.PythonGuest(
    "[n*n for n in range(4)]",
    "/tmp/example.py",
    true,
    1_048_576,
    "{}",
  );
  native.__cirro_limits(1_000_000n, 512);
  const step = Schema.decodeUnknownSync(Schema.fromJsonString(Completed))(guest.step());
  expect(step.output.result).toEqual([0, 1, 4, 9]);
  expect(native.__cirro_fuel.value).toBeLessThan(1_000_000n);
  expect(native.__cirro_fuel.value).toBeGreaterThan(0n);
  expect(native.__cirro_trap_reason.value).toBe(0);
  guest.free();
  const isolated = createBindings();
  const state = isolated.initSync({ module });
  state.__cirro_limits(100_000_000n, 512);
  const exhausted = new isolated.PythonGuest(
    "while True:\n pass",
    "/tmp/loop.py",
    false,
    1_048_576,
    "{}",
  );
  state.__cirro_limits(1000n, 512);
  expect(() => exhausted.step()).toThrow();
  expect(state.__cirro_fuel.value).toBe(0n);
  expect(state.__cirro_trap_reason.value).toBe(1);
  expect(() => exhausted.free()).not.toThrow();
  state.__cirro_limits(1000n, 512);
  expect(state.__cirro_trap_reason.value).toBe(0);
});

test("compiled Python memory ceiling rejects growth before allocation independently of its instruction budget", () => {
  const bindings = createBindings();
  const native = bindings.initSync({ module });
  native.__cirro_limits(100_000_000n, 512);
  const guest = new bindings.PythonGuest("[0] * 1000000", "/tmp/memory.py", true, 1_048_576, "{}");
  const size = native.memory.buffer.byteLength;
  native.__cirro_limits(100_000_000n, size / 65_536);
  expect(() => guest.step()).toThrow();
  expect(native.memory.buffer.byteLength).toBe(size);
  expect(native.__cirro_fuel.value).toBeGreaterThan(0n);
  expect(native.__cirro_trap_reason.value).toBe(2);
  guest.free();
  expect(() => native.__cirro_limits(100_000_000n, size / 65_536 - 1)).toThrow();
  expect(native.__cirro_trap_reason.value).toBe(3);
  native.__cirro_limits(100_000_000n, size / 65_536);
  expect(native.__cirro_trap_reason.value).toBe(0);
});

test("native Python suspension traps an exhausted saved stack before adopting a host request", () => {
  const observed = { requests: 0, responses: 0 };
  const bindings = createBindings({
    request() {
      observed.requests += 1;
      native.asyncify_start_unwind(stack);
      return 0;
    },
    response() {
      observed.responses += 1;
      return -1;
    },
  });
  const native = bindings.initSync({ module });
  native.__cirro_limits(100_000_000n, 512);
  const stack = bindings.io_stack();
  const guest = new bindings.PythonGuest(
    "import _boxes_io\n_boxes_io.call({'op':'filesystem.stat','path':'/','follow':True})",
    "/tmp/bounds.py",
    false,
    4096,
    "{}",
  );
  new DataView(native.memory.buffer).setUint32(stack + 4, stack + 8, true);
  expect(guest.poll()).toBe(0);
  expect(native.asyncify_get_state()).toBe(1);
  expect(() => native.asyncify_stop_unwind()).toThrow();
  expect(observed).toEqual({ requests: 1, responses: 0 });
  expect(() => guest.free()).not.toThrow();
});

test("Python definitions complete without exporting function objects and remain callable in their native scope", () =>
  Effect.runSync(
    Effect.scoped(
      Effect.gen(function* () {
        for (const [source, expression, expected] of [
          ["def answer():\n return 42", "answer()", 42],
          ["class Answer:\n value = 42", "Answer.value", 42],
          ["async def answer():\n return 42", "answer.__name__", "answer"],
          ["@(lambda function: 42)\ndef answer():\n return 0", "answer", 42],
        ] as const) {
          yield* Effect.scoped(
            Effect.gen(function* () {
              const bindings = createBindings();
              const native = bindings.initSync({ module });
              native.__cirro_limits(100_000_000n, 512);
              const guest = yield* Effect.acquireRelease(
                Effect.sync(
                  () =>
                    new bindings.PythonGuest(source, "/tmp/definitions.py", false, 1_048_576, "{}"),
                ),
                (guest) => Effect.sync(() => guest.free()),
              );
              const defined = Schema.decodeUnknownSync(Schema.fromJsonString(Completed))(
                guest.step(),
              );
              expect(defined.output).toEqual({ stdout: "", stderr: "", result: null, exitCode: 0 });
              expect(guest.quiescent()).toBe(true);
              guest.begin(expression, "/tmp/use.py", true, "{}");
              const used = Schema.decodeUnknownSync(Schema.fromJsonString(Completed))(guest.step());
              expect(used.output.result).toBe(expected);
              expect(used.output.exitCode).toBe(0);
            }),
          );
        }
      }),
    ),
  ));

test("Python standard library performs JSON, regular expressions, cached calls and collections without host shims", () =>
  Effect.runSync(
    Effect.scoped(
      Effect.gen(function* () {
        const bindings = createBindings();
        const native = bindings.initSync({ module });
        native.__cirro_limits(100_000_000n, 1024);
        const guest = yield* Effect.acquireRelease(
          Effect.sync(
            () =>
              new bindings.PythonGuest(
                "import json, re, functools\nfrom collections import Counter, namedtuple\nfrom enum import IntEnum\nfrom weakref import WeakSet\n@functools.lru_cache(maxsize=8)\ndef answer(value):\n return value*2\nclass Level(IntEnum):\n ready=1\nPoint=namedtuple('Point',['x','y'])\njson.loads(json.dumps({'answer':answer(21),'matches':re.findall(r'[a-z]+','box 42 native'),'counts':dict(Counter('boxes')),'point':Point(1,2),'weak_count':len(WeakSet([Point])),'level':Level.ready,'unicode':'ação'},ensure_ascii=False,sort_keys=True))",
                "/tmp/stdlib.py",
                false,
                1_048_576,
                "{}",
              ),
          ),
          (guest) => Effect.sync(() => guest.free()),
        );
        const result = Schema.decodeUnknownSync(Schema.fromJsonString(Completed))(guest.step());
        expect(result.output.exitCode).toBe(0);
        expect(result.output.stderr).toBe("");
        expect(result.output.result).toEqual({
          answer: 42,
          matches: ["box", "native"],
          counts: { b: 1, o: 1, x: 1, e: 1, s: 1 },
          point: [1, 2],
          weak_count: 1,
          level: 1,
          unicode: "ação",
        });
        expect(guest.quiescent()).toBe(true);
        guest.begin("answer(21)", "/tmp/cached.py", true, "{}");
        expect(
          Schema.decodeUnknownSync(Schema.fromJsonString(Completed))(guest.step()).output.result,
        ).toBe(42);
      }),
    ),
  ));

test("Python reentrant locks retain depth, validate acquisition and restore ownership without threads", () =>
  Effect.runSync(
    Effect.scoped(
      Effect.gen(function* () {
        const bindings = createBindings();
        const native = bindings.initSync({ module });
        native.__cirro_limits(100_000_000n, 512);
        const guest = yield* Effect.acquireRelease(
          Effect.sync(
            () =>
              new bindings.PythonGuest(
                "from _thread import RLock,get_ident\nlock=RLock()\nassert not hasattr(lock.acquire,'__code__')\nassert not lock.locked()\nwith lock:\n assert lock._is_owned()\n assert lock.acquire(False)\n assert lock._recursion_count()==2\n state=lock._release_save()\n assert not lock.locked()\n lock._acquire_restore(state)\n assert lock._recursion_count()==2\n lock.release()\nassert not lock.locked()\nerrors=[]\nfor operation in [lambda:lock.release(),lambda:lock.acquire(False,1),lambda:lock.acquire(timeout=-2),lambda:lock.acquire(timeout=float('nan')),lambda:lock.acquire(timeout=float('inf')),lambda:lock._acquire_restore((1,2)),lambda:RLock(1)]:\n try:\n  operation()\n except (RuntimeError,ValueError,OverflowError,TypeError) as error:\n  errors.append(type(error).__name__)\n[errors,lock.locked(),state[0],state[1]==get_ident()]",
                "/tmp/locks.py",
                false,
                1_048_576,
                "{}",
              ),
          ),
          (guest) => Effect.sync(() => guest.free()),
        );
        const result = Schema.decodeUnknownSync(Schema.fromJsonString(Completed))(guest.step());
        expect(result.output.stderr).toBe("");
        expect(result.output.exitCode).toBe(0);
        expect(result.output.result).toEqual([
          [
            "RuntimeError",
            "ValueError",
            "ValueError",
            "ValueError",
            "OverflowError",
            "RuntimeError",
            "TypeError",
          ],
          false,
          2,
          true,
        ]);
        expect(guest.quiescent()).toBe(true);
      }),
    ),
  ));
