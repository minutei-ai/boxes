import { Config, Effect, Match, Redacted, Schema } from "effect";
import { join } from "node:path";
import { Action, CreateSandbox, MintCapability, TokenResponse, RunRecord } from "../src/contracts";

const configuration = await Effect.runPromise(
  Effect.gen(function* () {
    return { url: yield* Config.String("CIRRO_URL"), key: yield* Config.Redacted("CIRRO_API_KEY") };
  }),
);
const id = `handlers-proof-${crypto.randomUUID()}`;
const post = (path: string, credential: string, body: string) =>
  fetch(new URL(path, configuration.url), {
    method: "POST",
    keepalive: false,
    headers: { authorization: `Bearer ${credential}`, "content-type": "application/json" },
    body,
    signal: AbortSignal.timeout(60000),
  });
const created = await post(
  "/v1/sandboxes",
  Redacted.value(configuration.key),
  Schema.encodeSync(Schema.fromJsonString(CreateSandbox))({
    id,
    policy: {
      networkHosts: [],
      interruptBudget: 10000,
      memoryBytes: 8388608,
      maxOutputBytes: 1048576,
    },
  }),
);
if (created.status !== 201) process.exit(1);
const minted = await post(
  `/v1/sandboxes/${id}/capabilities`,
  Redacted.value(configuration.key),
  Schema.encodeSync(Schema.fromJsonString(MintCapability))({
    permissions: ["read", "write", "execute", "manage"],
    expiresInSeconds: 3600,
  }),
);
const token = Schema.decodeUnknownSync(TokenResponse)(await minted.json()).token;
const action = (input: typeof Action.Type) =>
  post(
    `/v1/sandboxes/${id}/action`,
    token,
    Schema.encodeSync(Schema.fromJsonString(Action))(input),
  );
const value = await action({
  op: "filesystem.writeFile",
  path: "/tmp/value",
  content: "abc",
  encoding: "utf8",
});
const receipts = await Effect.runPromise(
  Effect.forEach(
    [
      "self",
      "coalesce",
      "sliced",
      "missing",
      "bad-signature",
      "defer",
      "nodefer",
      "sa-mask",
      "reset",
      "upper",
      "io",
      "external",
      "restart",
      "external-io",
      "inherit",
      "inherit-default",
      "chld",
      "chld-stop",
      "nocldstop",
      "autoreap-ignore",
      "autoreap-default",
      "autoreap-user",
      "autoreap-late",
      "autoreap-many",
      "autoreap-multi",
      "cont-handler",
      "ignore-cont",
      "restart-poll",
    ] as const,
    (mode) =>
      Effect.tryPromise(async () => {
        const childMode = new Map([
          ["external", "child-handler"],
          ["restart", "child-restart"],
          ["external-io", "child-io"],
          ["inherit", "child-inherit"],
          ["inherit-default", "child-inherit"],
          ["chld", "child-exit"],
          ["chld-stop", "child-exit"],
          ["nocldstop", "child-exit"],
          ["autoreap-ignore", "child-exit"],
          ["autoreap-default", "child-exit"],
          ["autoreap-user", "child-exit"],
          ["autoreap-late", "child-exit"],
          ["autoreap-many", "child-exit"],
          ["autoreap-multi", "child-exit"],
          ["ignore-cont", "child-ignorecont"],
          ["restart-poll", "child-poll"],
        ]).get(mode);
        if (childMode !== undefined) {
          const child = Buffer.from(
            await Bun.file(
              join(import.meta.dir, `../dist/wasi-handlers-${childMode}.wasm`),
            ).arrayBuffer(),
          ).toString("base64");
          const uploaded = await action({
            op: "filesystem.writeFile",
            path: "/tmp/handler-child.wasm",
            content: child,
            encoding: "base64",
          });
          const executable = await action({
            op: "filesystem.chmod",
            path: "/tmp/handler-child.wasm",
            mode: 493,
          });
          if (uploaded.status !== 200 || executable.status !== 200) return { mode, passed: false };
        }
        const source = Buffer.from(
          await Bun.file(join(import.meta.dir, `../dist/wasi-handlers-${mode}.wasm`)).arrayBuffer(),
        ).toString("base64");
        const response = await action({ op: "process.run", id: mode, language: "wasm", source });
        const record = Schema.decodeUnknownSync(RunRecord)(await response.json());
        const expected =
          new Map([
            ["defer", "AaBb main\n"],
            ["nodefer", "ABba main\n"],
            ["sa-mask", "AaC main\n"],
            ["reset", "Aa"],
            ["missing", "unavailable\n"],
            ["bad-signature", "unavailable\n"],
            ["external", " main\n"],
            ["restart", " main\n"],
            ["external-io", " main\n"],
            ["inherit", " main\n"],
            ["inherit-default", " main\n"],
            ["chld", "C main\n"],
            ["chld-stop", "CCC main\n"],
            ["nocldstop", "C main\n"],
            ["autoreap-ignore", " auto\n"],
            ["autoreap-default", " auto\n"],
            ["autoreap-user", "C auto\n"],
            ["autoreap-late", " auto\n"],
            ["autoreap-many", " many\n"],
            ["autoreap-multi", "CC multi\n"],
            ["ignore-cont", " main\n"],
            ["restart-poll", " main\n"],
          ]).get(mode) ?? "Aa main\n";
        const output = Match.value(mode).pipe(
          Match.when("reset", () => record.output?.exitCode === 138),
          Match.orElse(() => record.output?.exitCode === 0 && record.output.result === 7),
        );
        return {
          mode,
          passed:
            response.status === 200 &&
            record.status === "exited" &&
            record.output?.stdout === expected &&
            output,
        };
      }),
  ),
);
const limits = await Effect.runPromise(
  Effect.forEach(["infinite", "nest-limit"] as const, (mode) =>
    Effect.tryPromise(async () => {
      const source = Buffer.from(
        await Bun.file(join(import.meta.dir, `../dist/wasi-handlers-${mode}.wasm`)).arrayBuffer(),
      ).toString("base64");
      const response = await action({ op: "process.run", id: mode, language: "wasm", source });
      const record = Schema.decodeUnknownSync(RunRecord)(await response.json());
      const healthy = Buffer.from(
        await Bun.file(join(import.meta.dir, "../dist/wasi-handlers-self.wasm")).arrayBuffer(),
      ).toString("base64");
      const subsequent = await action({
        op: "process.run",
        id: `after-${mode}`,
        language: "wasm",
        source: healthy,
      });
      const next = Schema.decodeUnknownSync(RunRecord)(await subsequent.json());
      return {
        mode,
        passed:
          response.status === 200 &&
          record.status === "failed" &&
          subsequent.status === 200 &&
          next.status === "exited" &&
          next.output?.result === 7 &&
          next.output.stdout === "Aa main\n",
      };
    }),
  ),
);
const disposed = await action({ op: "vm.dispose" });
const report = {
  measuredAt: new Date().toISOString(),
  url: configuration.url,
  sandboxId: id,
  profile: "minutei",
  runtime: "standard Worker",
  receipts,
  limits,
  disposal: disposed.status === 200,
  allPassed:
    value.status === 200 &&
    receipts.every((receipt) => receipt.passed) &&
    limits.every((receipt) => receipt.passed) &&
    disposed.status === 200,
  automaticChildReaping: true,
  alternateSignalStack: false,
  fullProcessParity: false,
};
await Bun.write(
  join(import.meta.dir, "../docs/evidence/handlers-production.json"),
  JSON.stringify(report, null, 2) + "\n",
);
console.log(JSON.stringify(report, null, 2));
if (!report.allPassed) process.exit(1);
