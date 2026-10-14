import { afterAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Schema } from "effect";
import { RunRecord, TokenResponse } from "../src/contracts";
import { runtime } from "../tooling/worker-test";
const directory = await mkdtemp(join(tmpdir(), "cirro-wasi-handlers-"));
const mf = runtime(directory, { consume: true, controlled: false });
const post = async (path: string, token: string, body: unknown) =>
  fetch(new URL(path, await mf.ready), {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
expect(
  (
    await post("/v1/sandboxes", "cirro-local-test-credential", {
      id: "handlers",
      policy: {
        networkHosts: [],
        interruptBudget: 1000,
        memoryBytes: 8388608,
        maxOutputBytes: 1048576,
      },
    })
  ).status,
).toBe(201);
const minted = await post("/v1/sandboxes/handlers/capabilities", "cirro-local-test-credential", {
  permissions: ["read", "write", "execute"],
  expiresInSeconds: 3600,
});
const token = Schema.decodeUnknownSync(TokenResponse)(await minted.json()).token;
const act = (body: unknown) => post("/v1/sandboxes/handlers/action", token, body);
afterAll(async () => {
  await mf.dispose();
  await rm(directory, { recursive: true, force: true });
});

expect(
  (await act({ op: "filesystem.writeFile", path: "/tmp/value", content: "abc", encoding: "utf8" }))
    .status,
).toBe(200);
for (const mode of [
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
] as const) {
  test(`native signal handler ${mode} preserves the main frame, masks and native host I/O`, async () => {
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
      expect(
        (
          await act({
            op: "filesystem.writeFile",
            path: "/tmp/handler-child.wasm",
            content: child,
            encoding: "base64",
          })
        ).status,
      ).toBe(200);
      expect(
        (await act({ op: "filesystem.chmod", path: "/tmp/handler-child.wasm", mode: 493 })).status,
      ).toBe(200);
    }
    const source = Buffer.from(
      await Bun.file(join(import.meta.dir, `../dist/wasi-handlers-${mode}.wasm`)).arrayBuffer(),
    ).toString("base64");
    const response = await act({ op: "process.run", id: mode, language: "wasm", source });
    expect(response.status).toBe(200);
    const record = Schema.decodeUnknownSync(RunRecord)(await response.json());
    expect(record.status).toBe("exited");
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
    expect(record.output?.stdout).toBe(expected);
    if (mode === "reset") expect(record.output?.exitCode).toBe(138);
    else {
      expect(record.output?.exitCode).toBe(0);
      expect(record.output?.result).toBe(7);
    }
  });
}

for (const failureMode of ["infinite", "nest-limit"] as const) {
  test(`handler ${failureMode} respects its execution limit and cannot poison the Worker`, async () => {
    const source = Buffer.from(
      await Bun.file(
        join(import.meta.dir, `../dist/wasi-handlers-${failureMode}.wasm`),
      ).arrayBuffer(),
    ).toString("base64");
    const response = await act({ op: "process.run", id: failureMode, language: "wasm", source });
    expect(response.status).toBe(200);
    const record = Schema.decodeUnknownSync(RunRecord)(await response.json());
    expect(record.status).toBe("failed");
    const healthy = Buffer.from(
      await Bun.file(join(import.meta.dir, "../dist/wasi-handlers-self.wasm")).arrayBuffer(),
    ).toString("base64");
    const next = Schema.decodeUnknownSync(RunRecord)(
      await (
        await act({
          op: "process.run",
          id: `healthy-after-${failureMode}`,
          language: "wasm",
          source: healthy,
        })
      ).json(),
    );
    expect(next.status).toBe("exited");
    expect(next.output?.result).toBe(7);
    expect(next.output?.stdout).toBe("Aa main\n");
  });
}
