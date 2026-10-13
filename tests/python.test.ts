import { expect, test } from "bun:test";
import { Schema } from "effect";
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
  );
  native.__cirro_limits(1_000_000n, 512);
  const step = Schema.decodeUnknownSync(Schema.fromJsonString(Completed))(guest.step());
  expect(step.output.result).toEqual([0, 1, 4, 9]);
  expect(native.__cirro_fuel.value).toBeLessThan(1_000_000n);
  expect(native.__cirro_fuel.value).toBeGreaterThan(0n);
  guest.free();
  const isolated = createBindings();
  const state = isolated.initSync({ module });
  state.__cirro_limits(100_000_000n, 512);
  const exhausted = new isolated.PythonGuest(
    "while True:\n pass",
    "/tmp/loop.py",
    false,
    1_048_576,
  );
  state.__cirro_limits(1000n, 512);
  expect(() => exhausted.step()).toThrow();
  expect(state.__cirro_fuel.value).toBe(0n);
  expect(() => exhausted.free()).not.toThrow();
});

test("compiled Python memory ceiling rejects growth before allocation independently of its instruction budget", () => {
  const bindings = createBindings();
  const native = bindings.initSync({ module });
  native.__cirro_limits(100_000_000n, 512);
  const guest = new bindings.PythonGuest("[0] * 1000000", "/tmp/memory.py", true, 1_048_576);
  const size = native.memory.buffer.byteLength;
  native.__cirro_limits(100_000_000n, size / 65_536);
  expect(() => guest.step()).toThrow();
  expect(native.memory.buffer.byteLength).toBe(size);
  expect(native.__cirro_fuel.value).toBeGreaterThan(0n);
  guest.free();
});
