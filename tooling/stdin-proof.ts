import { Config, Effect, Redacted, Schema } from "effect";
import { join } from "node:path";
import {
  Action,
  CreateSandbox,
  MintCapability,
  TokenResponse,
  RunRecord,
  InputReceipt,
} from "../src/contracts";

const configuration = await Effect.runPromise(
  Effect.gen(function* () {
    return { url: yield* Config.String("CIRRO_URL"), key: yield* Config.Redacted("CIRRO_API_KEY") };
  }),
);
const id = `stdin-proof-${crypto.randomUUID()}`;
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
      interruptBudget: 100000,
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
const source = Buffer.from(
  await Bun.file(join(import.meta.dir, "../dist/wasi-stdin.wasm")).arrayBuffer(),
).toString("base64");
const spawn = await action({
  op: "process.spawn",
  stdinMode: "pipe",
  execution: {
    op: "process.run",
    id: "echo",
    language: "wasm",
    source,
    stdin: { content: "seed:", encoding: "utf8" },
  },
});
const payload = Buffer.from("hello\0world");
const mutation = {
  op: "process.stdin.write" as const,
  id: "echo",
  offset: 5,
  content: payload.toString("base64"),
  encoding: "base64" as const,
};
const written = await action(mutation);
const receipt = Schema.decodeUnknownSync(InputReceipt)(await written.json());
const retried = await action(mutation);
const repeated = Schema.decodeUnknownSync(InputReceipt)(await retried.json());
const conflict = await action({
  ...mutation,
  content: Buffer.from("different").toString("base64"),
});
const closed = await action({ op: "process.stdin.close", id: "echo", offset: 16 });
const finished = await action({ op: "process.wait", id: "echo", timeoutMs: 20000 });
const record = Schema.decodeUnknownSync(RunRecord)(await finished.json());
const large = await action({
  op: "process.spawn",
  stdinMode: "pipe",
  execution: { op: "process.run", id: "large", language: "wasm", source },
});
const writes = [];
for (const index of [0, 1, 2]) {
  const data = Buffer.alloc(65_536, 65 + index);
  const response = await action({
    op: "process.stdin.write",
    id: "large",
    offset: index * 65_536,
    content: data.toString("base64"),
    encoding: "base64",
  });
  writes.push(response.status === 200);
}
const drained = await action({ op: "process.stdin.close", id: "large", offset: 196_608 });
const largeWait = await action({ op: "process.wait", id: "large", timeoutMs: 20000 });
const largeRecord = Schema.decodeUnknownSync(RunRecord)(await largeWait.json());
const blocked = await action({
  op: "process.spawn",
  stdinMode: "pipe",
  execution: { op: "process.run", id: "cancel", language: "wasm", source },
});
const blockedReady = await Effect.runPromise(
  Effect.gen(function* () {
    for (const attempt of Array.from({ length: 30 }, (_, index) => index)) {
      const response = yield* Effect.tryPromise(() => action({ op: "process.get", id: "cancel" }));
      const current = Schema.decodeUnknownSync(RunRecord)(
        yield* Effect.tryPromise(() => response.json()),
      );
      if (current.status === "running" && current.output?.stdout === "ready\n") return true;
      if (attempt < 29) yield* Effect.sleep(500);
    }
    return false;
  }),
);
const pending = await action({ op: "process.wait", id: "cancel", timeoutMs: 1000 });
const cancellation = await action({ op: "process.cancel", id: "cancel" });
const cancellationWait = await action({ op: "process.wait", id: "cancel", timeoutMs: 10000 });
const cancelled = Schema.decodeUnknownSync(RunRecord)(
  await (await action({ op: "process.get", id: "cancel" })).json(),
);
const closeSource = Buffer.from(
  await Bun.file(join(import.meta.dir, "../dist/wasi-stdin-close.wasm")).arrayBuffer(),
).toString("base64");
const reader = await action({
  op: "process.spawn",
  stdinMode: "pipe",
  execution: { op: "process.run", id: "reader", language: "wasm", source: closeSource },
});
await action({ op: "process.wait", id: "reader", timeoutMs: 1000 });
const readerStatus = Schema.decodeUnknownSync(InputReceipt)(
  await (await action({ op: "process.stdin.status", id: "reader" })).json(),
);
const broken = await action({
  op: "process.stdin.write",
  id: "reader",
  offset: 0,
  content: "late",
  encoding: "utf8",
});
const readerWait = await action({ op: "process.wait", id: "reader", timeoutMs: 10000 });
const disposed = await action({ op: "vm.dispose" });
const checks = {
  spawn: spawn.status === 200,
  retained: written.status === 200 && receipt.offset === 16,
  retry: retried.status === 200 && repeated.offset === 16,
  conflict: conflict.status === 409,
  eof:
    closed.status === 200 &&
    finished.status === 200 &&
    record.status === "exited" &&
    record.output?.exitCode === 0 &&
    record.output.stdout === "ready\nseed:hello\0world\nbytes=16\n",
  boundedPipe:
    large.status === 200 &&
    writes.every(Boolean) &&
    drained.status === 200 &&
    largeWait.status === 200 &&
    largeRecord.output?.stdout ===
      "ready\n" + "A".repeat(65_536) + "B".repeat(65_536) + "C".repeat(65_536) + "\nbytes=196608\n",
  cancel:
    blocked.status === 200 &&
    blockedReady &&
    pending.status === 408 &&
    cancellation.status === 200 &&
    cancellationWait.status === 409 &&
    cancelled.status === "cancelled",
  lastReader:
    reader.status === 200 &&
    readerStatus.closed &&
    broken.status === 409 &&
    readerWait.status === 200,
  disposal: disposed.status === 200,
};
const report = {
  measuredAt: new Date().toISOString(),
  url: configuration.url,
  sandboxId: id,
  profile: "minutei",
  runtime: "standard Worker",
  checks,
  allPassed: Object.values(checks).every(Boolean),
  queuedInputRecoveryLocallyTested: true,
  liveInterpreterRecovery: false,
  pty: false,
  fullProcessParity: false,
};
await Bun.write(
  join(import.meta.dir, "../docs/evidence/stdin-production.json"),
  JSON.stringify(report, null, 2) + "\n",
);
console.log(JSON.stringify(report, null, 2));
if (!report.allPassed) process.exit(1);
