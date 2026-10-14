import { Config, Effect, Match, Redacted, Schema } from "effect";
import { join } from "node:path";
import { Action, CreateSandbox, MintCapability, TokenResponse, RunRecord } from "../src/contracts";

const configuration = await Effect.runPromise(
  Effect.gen(function* () {
    return { url: yield* Config.String("CIRRO_URL"), key: yield* Config.Redacted("CIRRO_API_KEY") };
  }),
);
const id = `signals-proof-${crypto.randomUUID()}`;
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
      interruptBudget: 1000,
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
const receipts = await Effect.runPromise(
  Effect.forEach(
    [
      "pid",
      "group",
      "masked",
      "unmask",
      "natural",
      "wait",
      "upper",
      "self",
      "inherit-mask",
      "stop",
      "tstp",
      "stop-kill",
      "stop-term",
      "self-stop",
      "stop-masked",
      "stop-group",
      "stop-zero",
      "stop-clock",
    ] as const,
    (mode) =>
      Effect.tryPromise(async () => {
        const childMode =
          new Map([
            ["masked", "child-masked"],
            ["unmask", "child-unmask"],
            ["natural", "child-natural"],
            ["wait", "child-wait"],
            ["inherit-mask", "child-inherited"],
            ["self-stop", "child-stopself"],
            ["stop-masked", "child-maskstop"],
            ["stop-clock", "child-clock"],
          ]).get(mode) ?? "child";
        const child = Buffer.from(
          await Bun.file(
            join(import.meta.dir, `../dist/wasi-signals-${childMode}.wasm`),
          ).arrayBuffer(),
        ).toString("base64");
        const uploaded = await action({
          op: "filesystem.writeFile",
          path: "/tmp/signal-child.wasm",
          content: child,
          encoding: "base64",
        });
        const executable = await action({
          op: "filesystem.chmod",
          path: "/tmp/signal-child.wasm",
          mode: 493,
        });
        if (mode === "wait") {
          const grandchild = Buffer.from(
            await Bun.file(join(import.meta.dir, "../dist/wasi-signals-child.wasm")).arrayBuffer(),
          ).toString("base64");
          const uploaded = await action({
            op: "filesystem.writeFile",
            path: "/tmp/signal-grandchild.wasm",
            content: grandchild,
            encoding: "base64",
          });
          const executable = await action({
            op: "filesystem.chmod",
            path: "/tmp/signal-grandchild.wasm",
            mode: 493,
          });
          if (uploaded.status !== 200 || executable.status !== 200) return { mode, passed: false };
        }
        const source = Buffer.from(
          await Bun.file(join(import.meta.dir, `../dist/wasi-signals-${mode}.wasm`)).arrayBuffer(),
        ).toString("base64");
        const response = await action({ op: "process.run", id: mode, language: "wasm", source });
        const record = Schema.decodeUnknownSync(RunRecord)(await response.json());
        const expected = Match.value(mode).pipe(
          Match.when("self", () => record.output?.exitCode === 137 && record.output.stdout === ""),
          Match.when(
            (mode) =>
              [
                "stop",
                "tstp",
                "stop-kill",
                "stop-term",
                "self-stop",
                "stop-masked",
                "stop-group",
                "stop-zero",
                "stop-clock",
              ].includes(mode),
            () =>
              record.output?.exitCode === 0 &&
              record.output.result === 0 &&
              record.output.stdout === "resumed\n",
          ),
          Match.orElse(
            () =>
              record.output?.exitCode === 0 &&
              record.output.result === 0 &&
              record.output.stdout === "signaled\n",
          ),
        );
        return {
          mode,
          passed:
            uploaded.status === 200 &&
            executable.status === 200 &&
            response.status === 200 &&
            record.status === "exited" &&
            expected,
        };
      }),
  ),
);
const pausedSource = Buffer.from(
  await Bun.file(join(import.meta.dir, "../dist/wasi-signals-self-pause.wasm")).arrayBuffer(),
).toString("base64");
const queued = await action({
  op: "process.spawn",
  execution: { op: "process.run", id: "self-pause", language: "wasm", source: pausedSource },
});
const checkpoints: (typeof RunRecord.Type)[] = [];
const deadline = Date.now() + 30000;
while (Date.now() < deadline && checkpoints.length === 0) {
  const record = Schema.decodeUnknownSync(RunRecord)(
    await (await action({ op: "process.get", id: "self-pause" })).json(),
  );
  if (record.status === "running" && record.output?.stdout === "paused\n") checkpoints.push(record);
  else await Bun.sleep(100);
}
const cancelled = await action({ op: "process.cancel", id: "self-pause" });
const waited = await action({ op: "process.wait", id: "self-pause", timeoutMs: 10000 });
const paused = Schema.decodeUnknownSync(RunRecord)(
  await (await action({ op: "process.get", id: "self-pause" })).json(),
);
const stoppedCancellation =
  queued.status === 200 &&
  checkpoints.length === 1 &&
  cancelled.status === 200 &&
  waited.status === 409 &&
  paused.status === "cancelled" &&
  paused.output?.stdout === "paused\n" &&
  paused.output.exitCode === null;
const disposed = await action({ op: "vm.dispose" });
const report = {
  measuredAt: new Date().toISOString(),
  url: configuration.url,
  sandboxId: id,
  profile: "minutei",
  runtime: "standard Worker",
  receipts,
  disposal: disposed.status === 200,
  stoppedCancellation,
  allPassed:
    receipts.every((receipt) => receipt.passed) && disposed.status === 200 && stoppedCancellation,
  stopContinue: true,
  customHandlers: false,
  fullProcessParity: false,
};
await Bun.write(
  join(import.meta.dir, "../docs/evidence/signals-production.json"),
  JSON.stringify(report, null, 2) + "\n",
);
console.log(JSON.stringify(report, null, 2));
if (!report.allPassed) process.exit(1);
