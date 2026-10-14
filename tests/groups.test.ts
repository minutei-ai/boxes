import { afterAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Schema } from "effect";
import { RunRecord, TokenResponse } from "../src/contracts";
import { runtime } from "../tooling/runtime";
const directory = await mkdtemp(join(tmpdir(), "cirro-wasi-groups-"));
const mf = runtime(directory);
const post = async (path: string, token: string, body: unknown) =>
  fetch(new URL(path, await mf.ready), {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
expect(
  (
    await post("/v1/sandboxes", "cirro-local-test-credential", {
      id: "groups",
      policy: {
        networkHosts: [],
        interruptBudget: 1000,
        memoryBytes: 8388608,
        maxOutputBytes: 1048576,
      },
    })
  ).status,
).toBe(201);
const minted = await post("/v1/sandboxes/groups/capabilities", "cirro-local-test-credential", {
  permissions: ["read", "write", "execute"],
  expiresInSeconds: 3600,
});
const token = Schema.decodeUnknownSync(TokenResponse)(await minted.json()).token;
const act = (body: unknown) => post("/v1/sandboxes/groups/action", token, body);
afterAll(async () => {
  await mf.dispose();
  await rm(directory, { recursive: true, force: true });
});

for (const mode of ["new", "join", "inherit"] as const) {
  test(`virtual process groups ${mode} obey spawn options, group membership and errno contracts`, async () => {
    const child = Buffer.from(
      await Bun.file(join(import.meta.dir, `../dist/wasi-groups-child-${mode}.wasm`)).arrayBuffer(),
    ).toString("base64");
    expect(
      (
        await act({
          op: "filesystem.writeFile",
          path: "/tmp/group.wasm",
          content: child,
          encoding: "base64",
        })
      ).status,
    ).toBe(200);
    expect((await act({ op: "filesystem.chmod", path: "/tmp/group.wasm", mode: 493 })).status).toBe(
      200,
    );
    const source = Buffer.from(
      await Bun.file(
        join(import.meta.dir, `../dist/wasi-groups-parent-${mode}.wasm`),
      ).arrayBuffer(),
    ).toString("base64");
    const response = await act({ op: "process.run", id: mode, language: "wasm", source });
    expect(response.status).toBe(200);
    const record = Schema.decodeUnknownSync(RunRecord)(await response.json());
    expect(record.status).toBe("exited");
    expect(record.output?.result).toBe(0);
    expect(record.output?.exitCode).toBe(0);
  });
}
