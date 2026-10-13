import { Config, Effect, Redacted, Schema } from "effect";
import { PackagePreparation, RunRecord, TokenResponse } from "../src/contracts";

const configuration = await Effect.runPromise(
  Effect.gen(function* () {
    const key = yield* Config.Redacted("CIRRO_API_KEY");
    const url = yield* Config.String("CIRRO_URL");
    return { key, url };
  }),
);
const digest = "edb1cf0bbcf663d177916592d2f1b4361a02966dbf2eb44e3e61ea2a399bb43a";
const artifact = await fetch(
  `https://releases.rivet.dev/agent-os/latest/software/packages/jq/${digest}.aospkg`,
  { signal: AbortSignal.timeout(30_000) },
);
const bytes = await artifact.arrayBuffer();
const actualDigest = Buffer.from(await crypto.subtle.digest("SHA-256", bytes)).toString("hex");
if (!artifact.ok || actualDigest !== digest) {
  console.error("Published jq artifact does not match the pinned SHA-256");
  process.exit(1);
}
const id = `software-proof-${crypto.randomUUID()}`;
const post = (path: string, token: string, body: unknown) =>
  fetch(new URL(path, configuration.url), {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(60_000),
  });
const created = await post("/v1/sandboxes", Redacted.value(configuration.key), {
  id,
  policy: {
    interruptBudget: 100000,
    memoryBytes: 33554432,
    maxOutputBytes: 1048576,
    networkHosts: [],
  },
});
const minted = await post(`/v1/sandboxes/${id}/capabilities`, Redacted.value(configuration.key), {
  permissions: ["read", "write", "execute", "manage"],
  expiresInSeconds: 3600,
});
const token = Schema.decodeUnknownSync(TokenResponse)(await minted.json()).token;
const action = (body: unknown) => post(`/v1/sandboxes/${id}/action`, token, body);
const uploaded = await action({
  op: "filesystem.writeFile",
  path: "/tmp/jq.aospkg",
  content: Buffer.from(bytes).toString("base64"),
  encoding: "base64",
});
const installedResponse = await action({
  op: "software.install",
  source: { path: "/tmp/jq.aospkg", digest: `sha256:${digest}` },
});
const installed = Schema.decodeUnknownSync(PackagePreparation.fields.installed)(
  await installedResponse.json(),
);
const cases = [
  { id: "version", args: ["--version"], stdin: "", expected: "jq-jaq-0.1.0\n" },
  { id: "stdin", args: [".value"], stdin: '{"value":42}', expected: "42\n" },
  { id: "filter", args: ["-n", "[range(0;10)] | add"], stdin: "", expected: "45\n" },
  { id: "file", args: [".value", "/tmp/input.json"], stdin: "", expected: "73\n" },
];
const written = await action({
  op: "filesystem.writeFile",
  path: "/tmp/input.json",
  content: '{"value":73}',
  encoding: "utf8",
});
const receipts = await Effect.runPromise(
  Effect.forEach(
    cases,
    (entry) =>
      Effect.tryPromise(async () => {
        const started = performance.now();
        const response = await action({
          op: "process.execFile",
          id: entry.id,
          command: "jq",
          args: entry.args,
          stdin: { content: entry.stdin, encoding: "utf8" },
        });
        const record = Schema.decodeUnknownSync(RunRecord)(await response.json());
        return {
          id: entry.id,
          output: record.output,
          elapsedMs: performance.now() - started,
          ok:
            response.status === 200 &&
            record.status === "exited" &&
            record.output?.exitCode === 0 &&
            record.output.stdout === entry.expected,
        };
      }),
    { concurrency: 1 },
  ),
);
const pipeline = Schema.decodeUnknownSync(RunRecord)(
  await (
    await action({
      op: "process.run",
      language: "shell",
      id: "pipeline",
      source: `echo '{"value":91}' | jq .value > /tmp/output; cat /tmp/output`,
    })
  ).json(),
);
const disposed = await action({ op: "vm.dispose" });
const checks = {
  created: created.status === 201,
  uploaded: uploaded.status === 200,
  installed: installed.digest === `sha256:${digest}`,
  written: written.status === 200,
  commands: receipts.every((receipt) => receipt.ok),
  pipeline: pipeline.output?.exitCode === 0 && pipeline.output.stdout === "91\n",
  disposed: disposed.status === 200,
};
console.log(JSON.stringify({ artifact: `sha256:${digest}`, checks, receipts }, null, 2));
if (!Object.values(checks).every(Boolean)) process.exit(1);
