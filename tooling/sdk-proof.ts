import { Config, Effect, Redacted } from "effect";
import { FetchHttpClient } from "effect/http";
import { make } from "../dist/sdk/sdk.js";

await Effect.runPromise(
  Effect.gen(function* () {
    const url = yield* Config.String("CIRRO_URL");
    const token = yield* Config.Redacted("CIRRO_API_KEY");
    const admin = yield* make({ url, token });
    const id = `sdk-proof-${crypto.randomUUID()}`;
    yield* admin.create({
      id,
      policy: {
        networkHosts: [],
        interruptBudget: 1000,
        memoryBytes: 8388608,
        maxOutputBytes: 1048576,
      },
    });
    const capability = yield* admin.mintCapability(id, {
      permissions: ["read", "write", "execute", "manage"],
      expiresInSeconds: 600,
    });
    const sandbox = yield* make({ url, token: Redacted.make(capability.token) });
    yield* sandbox.action(id, {
      op: "filesystem.writeFile",
      path: "/sdk-proof",
      content: "effect-native",
      encoding: "utf8",
    });
    const file = yield* sandbox.action(id, { op: "filesystem.readFile", path: "/sdk-proof" });
    if (Buffer.from(file.content, file.encoding).toString() !== "effect-native")
      return yield* Effect.die("SDK content mismatch");
    const record = yield* sandbox.action(id, {
      op: "typescript.evaluate",
      id: "evaluate",
      expression: "21 * 2",
    });
    if (record.status !== "exited" || record.output?.result !== 42)
      return yield* Effect.die(record);
    const denied = yield* sandbox
      .create({
        id: `${id}-denied`,
        policy: {
          networkHosts: [],
          interruptBudget: 1000,
          memoryBytes: 8388608,
          maxOutputBytes: 1048576,
        },
      })
      .pipe(Effect.flip);
    if (denied._tag !== "BoxesError" || denied.status !== 401)
      return yield* Effect.die("SDK authorization mismatch");
    yield* sandbox.action(id, { op: "vm.dispose" });
    console.log(
      JSON.stringify({
        checks: 6,
        passed: true,
        transport: "Effect FetchHttpClient",
        target: "production",
      }),
    );
  }).pipe(Effect.provide(FetchHttpClient.layer)),
);
