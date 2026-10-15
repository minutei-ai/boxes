import { Clock, Config, Effect, Redacted, Schema } from "effect";
import { FetchHttpClient } from "effect/http";
import { make } from "../dist/sdk/sdk.js";
import { commandPackage } from "../tests/fixtures/package";

const Report = Schema.Struct({
  target: Schema.String,
  measuredAt: Schema.Int,
  checks: Schema.Array(
    Schema.Struct({ name: Schema.String, status: Schema.Int, error: Schema.String }),
  ),
  validOverride: Schema.Boolean,
  configuredRuntimes: Schema.Array(Schema.String),
  disposal: Schema.Boolean,
});
const report = await Effect.runPromise(
  Effect.scoped(
    Effect.gen(function* () {
      const url = yield* Config.String("CIRRO_URL");
      const token = yield* Config.Redacted("CIRRO_API_KEY");
      const admin = yield* make({ url, token });
      const id = `environment-${crypto.randomUUID()}`;
      const measuredAt = yield* Clock.currentTimeMillis;
      yield* Effect.acquireRelease(
        admin.create({
          id,
          policy: {
            networkHosts: [],
            interruptBudget: 1000,
            memoryBytes: 8388608,
            maxOutputBytes: 1048576,
          },
        }),
        () =>
          Effect.gen(function* () {
            const grant = yield* admin.mintCapability(id, {
              permissions: ["manage"],
              expiresInSeconds: 60,
            });
            const manager = yield* make({ url, token: Redacted.make(grant.token) });
            yield* manager.action(id, { op: "vm.dispose" });
          }).pipe(Effect.orDie),
      );
      const grant = yield* admin.mintCapability(id, {
        permissions: ["read", "write", "execute", "manage"],
        expiresInSeconds: 600,
      });
      const client = yield* make({ url, token: Redacted.make(grant.token) });
      const binary = Buffer.from(
        yield* Effect.promise(() => Bun.file("dist/wasi-inputs.wasm").arrayBuffer()),
      );
      const defaults = {
        CIRRO_MARKER: "package",
        ...Object.fromEntries(Array.from({ length: 127 }, (_, index) => [`BASE_${index}`, "v"])),
      };
      yield* client.action(id, {
        op: "filesystem.writeFile",
        path: "/tmp/package",
        content: commandPackage(binary, "probe", "1.0.0", defaults).toString("base64"),
        encoding: "base64",
      });
      yield* client.action(id, { op: "software.install", source: { path: "/tmp/package" } });
      const before = yield* client.action(id, { op: "vm.status" });
      const cases = [
        {
          name: "merged-count",
          env: Object.fromEntries(
            Array.from({ length: 128 }, (_, index) => [`CALLER_${index}`, "v"]),
          ),
          error: "E2BIG",
          status: 413,
        },
        {
          name: "merged-bytes",
          env: Object.fromEntries(
            Array.from({ length: 32 }, (_, index) => [`BASE_${index}`, "v".repeat(4096)]),
          ),
          error: "E2BIG",
          status: 413,
        },
        {
          name: "utf8-path",
          env: { PATH: String.fromCharCode(0xd800) },
          error: "EINVAL",
          status: 400,
        },
        {
          name: "utf8-key",
          env: { [String.fromCharCode(0xd800)]: "v" },
          error: "EINVAL",
          status: 400,
        },
        {
          name: "utf8-value",
          env: { CIRRO_MARKER: "é".repeat(4096) },
          error: "EINVAL",
          status: 400,
        },
      ];
      const checks = yield* Effect.forEach(cases, (item) =>
        Effect.gen(function* () {
          const failure = yield* client
            .action(id, { op: "process.execFile", id: item.name, command: "probe", env: item.env })
            .pipe(Effect.flip);
          if (
            failure._tag !== "BoxesError" ||
            failure.error !== item.error ||
            failure.status !== item.status
          )
            return yield* Effect.die(`Unexpected WASI environment rejection: ${item.name}`);
          const absent = yield* client
            .action(id, { op: "process.get", id: item.name })
            .pipe(Effect.flip);
          if (absent._tag !== "BoxesError" || absent.error !== "ENOENT" || absent.status !== 404)
            return yield* Effect.die("Invalid environment reserved a process");
          const current = yield* client.action(id, { op: "vm.status" });
          if (current.generation !== before.generation)
            return yield* Effect.die("Invalid environment changed filesystem generation");
          return { name: item.name, status: failure.status, error: failure.error };
        }),
      );
      const valid = yield* client.action(id, {
        op: "process.execFile",
        id: "override",
        command: "probe",
        args: ["argument"],
        env: { CIRRO_MARKER: "caller" },
      });
      if (
        valid.status !== "exited" ||
        valid.output?.exitCode !== 0 ||
        !valid.output.stdout.includes("caller")
      )
        return yield* Effect.die("Valid environment override did not execute");
      yield* client.action(id, {
        op: "config.patch",
        policy: {},
        environment: { CIRRO_MARKER: "configured" },
      });
      const configuration = yield* client.action(id, { op: "config.get" });
      if (configuration.environment.CIRRO_MARKER !== "configured")
        return yield* Effect.die("Persisted environment was not observable");
      const javascript = yield* client.action(id, {
        op: "javascript.evaluate",
        id: "configured-javascript",
        expression: "[process.env.CIRRO_MARKER, typeof process.binding]",
      });
      yield* Schema.decodeUnknownEffect(
        Schema.Tuple([Schema.Literal("configured"), Schema.Literal("undefined")]),
      )(javascript.output?.result);
      const python = yield* client.action(id, {
        op: "python.evaluate",
        id: "configured-python",
        expression: "__import__('os').getenv('CIRRO_MARKER')",
      });
      if (python.output?.result !== "configured")
        return yield* Effect.die("Python lost configured environment");
      const configuredShell = yield* client.action(id, {
        op: "process.run",
        id: "configured-shell",
        language: "shell",
        source: "probe",
      });
      const wasm = yield* client.action(id, {
        op: "process.execFile",
        id: "configured-wasm",
        command: "probe",
      });
      for (const run of [configuredShell, wasm]) {
        if (run.status !== "exited" || !run.output?.stdout.includes("configured"))
          return yield* Effect.die("Configured command environment differs");
      }
      const overridden = yield* client.action(id, {
        op: "typescript.evaluate",
        id: "configured-override",
        expression: "process.env.CIRRO_MARKER",
        env: { CIRRO_MARKER: "caller" },
      });
      if (overridden.output?.result !== "caller")
        return yield* Effect.die("Caller environment did not override configuration");
      yield* client.action(id, {
        op: "filesystem.writeFile",
        path: "/tmp/other-package",
        content: commandPackage(binary, "other", "1.0.0", { OTHER: "v" }).toString("base64"),
        encoding: "base64",
      });
      yield* client.action(id, { op: "software.install", source: { path: "/tmp/other-package" } });
      const union = yield* client
        .action(id, { op: "process.execFile", id: "package-union", command: "probe" })
        .pipe(Effect.flip);
      if (union._tag !== "BoxesError" || union.status !== 413 || union.error !== "E2BIG")
        return yield* Effect.die("Package union did not enforce the environment count");
      const absent = yield* client
        .action(id, { op: "process.get", id: "package-union" })
        .pipe(Effect.flip);
      if (absent._tag !== "BoxesError" || absent.status !== 404)
        return yield* Effect.die("Package union reserved a process");
      const shell = yield* client
        .action(id, { op: "process.run", id: "shell-union", language: "shell", source: "probe" })
        .pipe(Effect.flip);
      if (shell._tag !== "BoxesError" || shell.status !== 413 || shell.error !== "E2BIG")
        return yield* Effect.die("Shell admitted an invalid environment");
      checks.push({ name: "package-union", status: union.status, error: union.error });
      return {
        target: url,
        measuredAt,
        checks,
        validOverride: true,
        configuredRuntimes: ["javascript", "typescript", "python", "shell", "wasm"],
        disposal: true,
      };
    }),
  ).pipe(Effect.provide(FetchHttpClient.layer)),
);
console.log(await Effect.runPromise(Schema.encodeEffect(Schema.fromJsonString(Report))(report)));
