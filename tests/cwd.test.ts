import { afterAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Schema } from "effect";
import { RunRecord, TokenResponse } from "../src/contracts";
import { runtime } from "../tooling/runtime";
const directory = await mkdtemp(join(tmpdir(), "cirro-wasi-cwd-"));
const mf = runtime(directory);
const digest = "edb1cf0bbcf663d177916592d2f1b4361a02966dbf2eb44e3e61ea2a399bb43a";
const artifact = await fetch(
  `https://releases.rivet.dev/agent-os/latest/software/packages/jq/${digest}.aospkg`,
);
expect(artifact.status).toBe(200);
const bytes = await artifact.arrayBuffer();
expect(Buffer.from(await crypto.subtle.digest("SHA-256", bytes)).toString("hex")).toBe(digest);
const post = async (path: string, token: string, body: unknown) =>
  fetch(new URL(path, await mf.ready), {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
expect(
  (
    await post("/v1/sandboxes", "cirro-local-test-credential", {
      id: "cwd",
      policy: {
        networkHosts: [],
        interruptBudget: 100000,
        memoryBytes: 8388608,
        maxOutputBytes: 1048576,
      },
    })
  ).status,
).toBe(201);
const token = Schema.decodeUnknownSync(TokenResponse)(
  await (
    await post("/v1/sandboxes/cwd/capabilities", "cirro-local-test-credential", {
      permissions: ["read", "write", "execute", "manage"],
      expiresInSeconds: 3600,
    })
  ).json(),
).token;
const act = (body: unknown) => post("/v1/sandboxes/cwd/action", token, body);
expect(
  (
    await act({
      op: "filesystem.writeFile",
      path: "/tmp/jq.aospkg",
      content: Buffer.from(bytes).toString("base64"),
      encoding: "base64",
    })
  ).status,
).toBe(200);
expect(
  (
    await act({
      op: "software.install",
      source: { path: "/tmp/jq.aospkg", digest: `sha256:${digest}` },
    })
  ).status,
).toBe(200);
expect((await act({ op: "filesystem.mkdir", path: "/tmp/work", recursive: true })).status).toBe(
  200,
);
expect(
  (
    await act({
      op: "filesystem.writeFile",
      path: "/tmp/work/input.json",
      content: '{"value":77}',
      encoding: "utf8",
    })
  ).status,
).toBe(200);
expect(
  (await act({ op: "filesystem.symlink", target: "/tmp/work", path: "/tmp/link" })).status,
).toBe(200);
expect(
  (await act({ op: "filesystem.symlink", target: "/opt/cirro/bin/jq", path: "/tmp/work/jq" }))
    .status,
).toBe(200);
afterAll(async () => {
  await mf.dispose();
  await rm(directory, { recursive: true, force: true });
});

for (const mode of ["explicit", "relative", "chdir", "fchdir", "symlink"] as const) {
  test(`spawn ${mode} supplies the resolved cwd to published libc and opens a relative input`, async () => {
    const source = Buffer.from(
      await Bun.file(join(import.meta.dir, `../dist/wasi-cwd-${mode}.wasm`)).arrayBuffer(),
    ).toString("base64");
    const response = await act({ op: "process.run", id: mode, language: "wasm", source });
    expect(response.status).toBe(200);
    const record = Schema.decodeUnknownSync(RunRecord)(await response.json());
    expect(record.status).toBe("exited");
    expect(record.output?.exitCode).toBe(0);
    expect(record.output?.result).toBe(0);
    expect(record.output?.stdout).toBe("77\n");
  }, 15000);
}
for (const [mode, errno] of [
  ["missing", 44],
  ["file", 54],
  ["closed", 8],
  ["malformed", 28],
] as const) {
  test(`spawn ${mode} rejects before allocating a child PID`, async () => {
    const source = Buffer.from(
      await Bun.file(join(import.meta.dir, `../dist/wasi-cwd-${mode}.wasm`)).arrayBuffer(),
    ).toString("base64");
    const record = Schema.decodeUnknownSync(RunRecord)(
      await (await act({ op: "process.run", id: mode, language: "wasm", source })).json(),
    );
    expect(record.output?.result).toBe(errno);
    expect(record.output?.stdout).toBe("");
  });
}
