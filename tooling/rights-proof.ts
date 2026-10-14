import { Config, Effect, Redacted } from "effect";
import { FetchHttpClient } from "effect/http";
import { make } from "../dist/sdk/sdk.js";

await Effect.runPromise(
  Effect.gen(function* () {
    const url = yield* Config.String("CIRRO_URL");
    const token = yield* Config.Redacted("CIRRO_API_KEY");
    const admin = yield* make({ url, token });
    const id = `rights-${crypto.randomUUID()}`;
    yield* admin.create({
      id,
      policy: {
        networkHosts: [],
        interruptBudget: 1000,
        memoryBytes: 8388608,
        maxOutputBytes: 1048576,
      },
    });
    const grant = yield* admin.mintCapability(id, {
      permissions: ["read", "write", "execute", "manage"],
      expiresInSeconds: 600,
    });
    const boxes = yield* make({ url, token: Redacted.make(grant.token) });
    const source = Buffer.from(
      yield* Effect.promise(() => Bun.file("dist/wasi-attenuation.wasm").arrayBuffer()),
    ).toString("base64");
    const record = yield* boxes.action(id, {
      op: "process.run",
      id: "rights",
      language: "wasm",
      source,
    });
    if (
      record.status !== "exited" ||
      record.output?.exitCode !== 0 ||
      record.output.stdout !== "rights reductions retained across aliases and suspension\n"
    )
      return yield* Effect.die(record);
    const file = yield* boxes.action(id, { op: "filesystem.readFile", path: "/tmp/rights" });
    if (Buffer.from(file.content, file.encoding).toString() !== "retained")
      return yield* Effect.die("file bytes changed");
    const denied = yield* boxes.action(id, { op: "filesystem.exists", path: "/tmp/denied" });
    if (denied.exists) return yield* Effect.die("reduced directory rights allowed creation");
    yield* boxes.action(id, { op: "vm.dispose" });
    console.log(
      JSON.stringify({
        checks: 4,
        passed: true,
        feature: "fd_fdstat_set_rights",
        target: "production",
      }),
    );
  }).pipe(Effect.provide(FetchHttpClient.layer)),
);
