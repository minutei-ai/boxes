import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Schema } from "effect";
import { RunRecord, TokenResponse } from "../src/contracts";
import { runtime } from "../tooling/worker-test";

test("lazy Wasmi translation validates malformed unused functions before guest entry", async () => {
  const directory = await mkdtemp(join(tmpdir(), "boxes-wasmi-validation-"));
  const worker = runtime(directory);
  const post = async (path: string, credential: string, body: unknown) =>
    fetch(new URL(path, await worker.ready), {
      method: "POST",
      headers: { authorization: `Bearer ${credential}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  expect(
    (
      await post("/v1/sandboxes", "cirro-local-test-credential", {
        id: "validation",
        policy: {
          networkHosts: [],
          interruptBudget: 1000,
          memoryBytes: 8388608,
          maxOutputBytes: 1048576,
        },
      })
    ).status,
  ).toBe(201);
  const token = Schema.decodeUnknownSync(TokenResponse)(
    await (
      await post("/v1/sandboxes/validation/capabilities", "cirro-local-test-credential", {
        permissions: ["execute"],
        expiresInSeconds: 3600,
      })
    ).json(),
  ).token;
  const image = Buffer.from([
    0, 97, 115, 109, 1, 0, 0, 0, 1, 4, 1, 96, 0, 0, 3, 3, 2, 0, 0, 7, 10, 1, 6, 95, 115, 116, 97,
    114, 116, 0, 0, 10, 8, 2, 2, 0, 11, 3, 0, 106, 11,
  ]).toString("base64");
  const response = await post("/v1/sandboxes/validation/action", token, {
    op: "process.run",
    id: "malformed",
    language: "wasm",
    source: image,
  });
  expect(response.status).toBe(200);
  const record = Schema.decodeUnknownSync(RunRecord)(await response.json());
  expect(record.status).toBe("failed");
  expect(record.output).toBeNull();
  const healthy = await fetch(new URL("/health", await worker.ready));
  expect(healthy.status).toBe(200);
  await worker.dispose();
  await rm(directory, { recursive: true, force: true });
});
