import { afterAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Schema } from "effect";
import { RunRecord, TokenResponse, LiveOutputPage, ErrorResponse } from "../src/contracts";
import { runtime } from "../tooling/runtime";

const directory = await mkdtemp(join(tmpdir(), "cirro-pipe-"));
const mf = runtime(directory);
const admin = "cirro-local-test-credential";
const post = async (path: string, token: string, body: unknown) =>
  fetch(new URL(path, await mf.ready), {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
const created = await post("/v1/sandboxes", admin, {
  id: "pipe",
  policy: {
    networkHosts: [],
    interruptBudget: 1000,
    memoryBytes: 8388608,
    maxOutputBytes: 1048576,
  },
});
expect(created.status).toBe(201);
const minted = await post("/v1/sandboxes/pipe/capabilities", admin, {
  permissions: ["read", "execute"],
  expiresInSeconds: 3600,
});
const token = Schema.decodeUnknownSync(TokenResponse)(await minted.json()).token;
const act = (body: unknown) => post("/v1/sandboxes/pipe/action", token, body);
afterAll(async () => {
  await mf.dispose();
  await rm(directory, { recursive: true, force: true });
});

test("pipes bound buffering, preserve atomic writes and aliases, and report readiness, EOF and EPIPE", async () => {
  const source = Buffer.from(
    await Bun.file(join(import.meta.dir, "../dist/wasi-pipe-normal.wasm")).arrayBuffer(),
  ).toString("base64");
  const response = await act({ op: "process.run", id: "io", language: "wasm", source });
  expect(response.status).toBe(200);
  const record = Schema.decodeUnknownSync(RunRecord)(await response.json());
  expect(record.status).toBe("exited");
  expect(record.output?.result).toBe(0);
  expect(record.output?.exitCode).toBe(0);
});

test("empty blocking pipe waits rather than returning fake EOF and explicit cancellation closes its guest", async () => {
  const source = Buffer.from(
    await Bun.file(join(import.meta.dir, "../dist/wasi-pipe-blocked.wasm")).arrayBuffer(),
  ).toString("base64");
  expect(
    (
      await act({
        op: "process.spawn",
        execution: { op: "process.run", id: "blocked", language: "wasm", source },
      })
    ).status,
  ).toBe(200);
  const deadline = performance.now() + 10000;
  const snapshots: (typeof LiveOutputPage.Type)[] = [];
  while (performance.now() < deadline) {
    const page = Schema.decodeUnknownSync(LiveOutputPage)(
      await (
        await act({
          op: "process.output.readLive",
          id: "blocked",
          after: null,
          maxBytes: 4096,
          maxEvents: 1,
        })
      ).json(),
    );
    if (page.events.length > 0) {
      snapshots.push(page);
      break;
    }
    await Bun.sleep(50);
  }
  expect(snapshots[0]?.state).toBe("running");
  expect(Buffer.from(snapshots[0]?.events[0]?.data ?? "", "base64").toString()).toBe(
    "blocked pipe",
  );
  const observation = await act({ op: "process.wait", id: "blocked", timeoutMs: 0 });
  expect(observation.status).toBe(408);
  expect((await act({ op: "process.cancel", id: "blocked" })).status).toBe(200);
  const waited = await act({ op: "process.wait", id: "blocked", timeoutMs: 10000 });
  expect(waited.status).toBe(409);
  expect(Schema.decodeUnknownSync(ErrorResponse)(await waited.json()).error).toBe("ECANCELED");
  const record = Schema.decodeUnknownSync(RunRecord)(
    await (await act({ op: "process.get", id: "blocked" })).json(),
  );
  expect(record.status).toBe("cancelled");
  expect(record.output?.stdout).toBe("blocked pipe");
  expect(record.output?.exitCode).toBeNull();
}, 15000);
