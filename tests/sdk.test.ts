import { afterAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Exit, Fiber, Layer, Redacted, Schema } from "effect";
import { FetchHttpClient } from "effect/http";
import { make } from "../src/sdk";
import { runtime } from "../tooling/worker-test";

const directory = await mkdtemp(join(tmpdir(), "boxes-sdk-"));
const worker = runtime(directory, {
  controlled: false,
  origin: { delay: 100, body: '{"unexpected":true}' },
});
const transport = FetchHttpClient.layer.pipe(
  Layer.provide(Layer.succeed(FetchHttpClient.RequestInit, { keepalive: false })),
);
const run = <A, E>(program: Effect.Effect<A, E, import("effect/http/HttpClient").HttpClient>) =>
  Effect.runPromise(program.pipe(Effect.provide(transport)));
const policy = {
  networkHosts: [],
  interruptBudget: 1000,
  memoryBytes: 8388608,
  maxOutputBytes: 1048576,
};
const administrator = await run(
  make({
    url: (await worker.ready).toString(),
    token: Redacted.make("cirro-local-test-credential"),
  }),
);
afterAll(async () => {
  await worker.dispose();
  await rm(directory, { recursive: true, force: true });
});
test("Effect SDK preserves typed results, scoped permissions and remote error codes", async () => {
  expect((await run(administrator.create({ id: "sdk", policy }))).id).toBe("sdk");
  const capability = await run(
    administrator.mintCapability("sdk", {
      permissions: ["read", "write", "execute", "manage"],
      expiresInSeconds: 3600,
    }),
  );
  const sandbox = await run(
    make({ url: (await worker.ready).toString(), token: Redacted.make(capability.token) }),
  );
  expect(
    (
      await run(
        sandbox.action("sdk", {
          op: "filesystem.writeFile",
          path: "/sdk",
          content: "native effect",
          encoding: "utf8",
        }),
      )
    ).ok,
  ).toBe(true);
  const file = await run(sandbox.action("sdk", { op: "filesystem.readFile", path: "/sdk" }));
  expect(Buffer.from(file.content, file.encoding).toString()).toBe("native effect");
  expect(
    (await run(sandbox.action("sdk", { op: "filesystem.stat", path: "/sdk", follow: true }))).size,
  ).toBe(13);
  const executed = await run(
    sandbox.action("sdk", { op: "typescript.evaluate", id: "sdk-run", expression: "6 * 7" }),
  );
  expect(executed.status).toBe("exited");
  expect(executed.output?.result).toBe(42);
  const snapshot = await run(sandbox.action("sdk", { op: "filesystem.export", maxBytes: 1048576 }));
  expect(
    (await run(administrator.create({ id: "sdk-copy", policy, snapshot }))).filesystemBytes,
  ).toBeGreaterThan(0);
  const duplicate = await run(administrator.create({ id: "sdk", policy }).pipe(Effect.flip));
  expect(duplicate).toMatchObject({ _tag: "BoxesError", status: 409, error: "EEXIST" });
  const forbidden = await run(sandbox.create({ id: "forbidden", policy }).pipe(Effect.flip));
  expect(forbidden).toMatchObject({ _tag: "BoxesError", status: 401 });
  expect((await run(sandbox.action("sdk", { op: "vm.dispose" }))).ok).toBe(true);
});
test("invalid sandbox identifiers fail before transport and credentials stay redacted", async () => {
  const failure = await run(
    administrator.action("../escape", { op: "vm.status" }).pipe(Effect.flip),
  );
  expect(failure._tag).toBe("SchemaError");
  expect(String(Redacted.make("private-token"))).not.toContain("private-token");
});

test("protocol failures stay typed and native fiber interruption does not replay requests", async () => {
  const origin = await worker.origin();
  const malformed = await run(make({ url: origin.toString(), token: Redacted.make("synthetic") }));
  const protocol = await run(malformed.action("sdk", { op: "vm.status" }).pipe(Effect.flip));
  expect(protocol._tag).toBe("SchemaError");
  const before = Schema.decodeUnknownSync(Schema.Int)(
    await (await fetch(new URL("/count", origin))).json(),
  );
  const interrupted = await run(
    Effect.gen(function* () {
      const fiber = yield* Effect.forkChild(malformed.action("sdk", { op: "vm.status" }));
      yield* Effect.sleep(25);
      yield* Fiber.interrupt(fiber);
      return yield* Fiber.await(fiber);
    }),
  );
  expect(Exit.hasInterrupts(interrupted)).toBe(true);
  const after = await (await fetch(new URL("/count", origin))).json();
  expect(after).toBe(before + 1);
});
