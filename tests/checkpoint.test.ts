import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { Miniflare } from "miniflare";
import { Schema } from "effect";
import { HeapSnapshot } from "../src/contracts";
import { CheckpointProof, CheckpointRequest } from "./fixtures/checkpoint-contract";

const source = Buffer.from(
  await Bun.file(join(import.meta.dir, "../dist/wasi-slices-finite.wasm")).arrayBuffer(),
).toString("base64");
const instance = (persist: string) =>
  new Miniflare({
    resourcePersistencePath: persist,
    workers: [
      {
        config: {
          name: "checkpoint",
          compatibilityDate: "2026-10-06",
          compatibilityFlags: ["nodejs_compat"],
          manifest: {
            mainModule: "index.js",
            modules: {
              "index.js": {
                type: "esm",
                contents: readFileSync(
                  join(import.meta.dir, "../dist/checkpoint-worker/index.js"),
                  "utf8",
                ),
              },
              ...Object.fromEntries(
                ["kernel", "wasi"].map((name) => [
                  `cirro_${name}_bg.wasm`,
                  {
                    type: "wasm" as const,
                    contents: readFileSync(
                      join(import.meta.dir, `../dist/checkpoint-worker/cirro_${name}_bg.wasm`),
                    ),
                  },
                ]),
              ),
            },
          },
          env: { OBJECTS: { type: "r2", name: "checkpoint-data" } },
        },
      },
    ],
  });
const send = async (runtime: ReturnType<typeof instance>, input: typeof CheckpointRequest.Type) =>
  fetch(await runtime.ready, {
    method: "POST",
    body: Schema.encodeSync(Schema.fromJsonString(CheckpointRequest))(input),
  });

test("R2 heap pages resume Wasmi frames in a replacement workerd without reentering the program", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cirro-checkpoint-"));
  const first = instance(directory);
  const response = await send(first, { op: "save", source });
  expect(response.status).toBe(200);
  const saved = Schema.decodeUnknownSync(CheckpointProof)(await response.json());
  expect(saved.op).toBe("saved");
  if (saved.op !== "saved" || saved.before.kind !== "yield") return expect(saved.op).toBe("saved");
  expect(saved.before.fuelUsed).toBeGreaterThan(0);
  await first.dispose();
  const second = instance(directory);
  const resumed = await send(second, { op: "resume", hash: saved.hash });
  expect(resumed.status).toBe(200);
  const proof = Schema.decodeUnknownSync(CheckpointProof)(await resumed.json());
  expect(proof.op).toBe("resumed");
  if (proof.op !== "resumed") return;
  expect(proof.after.kind).toBe("yield");
  if (proof.after.kind === "yield")
    expect(proof.after.fuelUsed).toBeGreaterThan(saved.before.fuelUsed);
  expect(proof.terminal.kind).toBe("done");
  if (proof.terminal.kind === "done") {
    expect(proof.terminal.output.exitCode).toBe(0);
    expect(proof.terminal.output.result).toBe(352);
    expect(proof.terminal.output.stdout).toBe("cpu loop started\n");
  }
  expect(proof.steps).toBeGreaterThan(1);
  await second.dispose();
  await rm(directory, { recursive: true, force: true });
}, 15000);

test("checkpoint integrity and Rust runtime identity are checked before native resume", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cirro-checkpoint-integrity-"));
  const runtime = instance(directory);
  const saved = Schema.decodeUnknownSync(CheckpointProof)(
    await (await send(runtime, { op: "save", source })).json(),
  );
  expect(saved.op).toBe("saved");
  if (saved.op !== "saved") return;
  const bucket = await runtime.getR2Bucket("OBJECTS");
  const key = `sandboxes/checkpoint-test/checkpoints/${saved.hash}.json`;
  const object = await bucket.get(key);
  expect(object).not.toBeNull();
  if (object === null) return;
  const snapshot = Schema.decodeUnknownSync(Schema.fromJsonString(HeapSnapshot))(
    await object.text(),
  );
  const mismatched = Schema.encodeSync(Schema.fromJsonString(HeapSnapshot))({
    ...snapshot,
    runtime: "0".repeat(64),
  });
  const hash = Buffer.from(await crypto.subtle.digest("SHA-256", Buffer.from(mismatched))).toString(
    "hex",
  );
  await bucket.put(`sandboxes/checkpoint-test/checkpoints/${hash}.json`, mismatched);
  const rejected = await send(runtime, { op: "resume", hash });
  expect(rejected.status).toBe(500);
  expect(await rejected.text()).toContain("another Rust runtime");
  const page = snapshot.pages[0];
  expect(page).toBeDefined();
  if (page === undefined) return;
  const pageKey = `sandboxes/checkpoint-test/checkpoint-pages/${page}`;
  const original = await bucket.get(pageKey);
  expect(original).not.toBeNull();
  if (original === null) return;
  const bytes = await original.arrayBuffer();
  const corrupted = new Uint8Array(bytes.slice(0));
  corrupted[0] = corrupted[0] ^ 1;
  await bucket.put(pageKey, corrupted);
  const failed = await send(runtime, { op: "resume", hash: saved.hash });
  expect(failed.status).toBe(500);
  expect(await failed.text()).toContain("Checkpoint page digest mismatch");
  await bucket.put(pageKey, bytes);
  const healthy = await send(runtime, { op: "resume", hash: saved.hash });
  expect(healthy.status).toBe(200);
  await runtime.dispose();
  await rm(directory, { recursive: true, force: true });
}, 15000);
test("one heap checkpoint retains child continuations, pipe buffers, EOF and wait status", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cirro-checkpoint-family-"));
  const first = instance(directory);
  const parent = Buffer.from(
    await Bun.file(
      join(import.meta.dir, "../dist/wasi-inherited-pipe-parent-duplex.wasm"),
    ).arrayBuffer(),
  ).toString("base64");
  const child = Buffer.from(
    await Bun.file(
      join(import.meta.dir, "../dist/wasi-inherited-pipe-child-duplex.wasm"),
    ).arrayBuffer(),
  ).toString("base64");
  const response = await send(first, { op: "save-family", source: parent, child });
  expect(response.status).toBe(200);
  const saved = Schema.decodeUnknownSync(CheckpointProof)(await response.json());
  expect(saved.op).toBe("saved");
  if (saved.op !== "saved") return;
  expect(saved.before.kind).toBe("poll");
  await first.dispose();
  const second = instance(directory);
  const resumed = await send(second, { op: "resume", hash: saved.hash });
  expect(resumed.status).toBe(200);
  const proof = Schema.decodeUnknownSync(CheckpointProof)(await resumed.json());
  expect(proof.op).toBe("resumed");
  if (proof.op !== "resumed") return;
  expect(proof.terminal.kind).toBe("done");
  if (proof.terminal.kind === "done") {
    expect(proof.terminal.output.exitCode).toBe(0);
    expect(proof.terminal.output.result).toBe(0);
    expect(proof.terminal.output.stdout).toBe("pipe handshake\n");
  }
  await second.dispose();
  await rm(directory, { recursive: true, force: true });
}, 15000);
test("a caught signal handler resumes its frame and mask without rerunning the main entry", async () => {
  const source = Buffer.from(
    await Bun.file(join(import.meta.dir, "../dist/wasi-handlers-sliced.wasm")).arrayBuffer(),
  ).toString("base64");
  const directory = await mkdtemp(join(tmpdir(), "cirro-checkpoint-handler-"));
  const first = instance(directory);
  const response = await send(first, { op: "save", source });
  expect(response.status).toBe(200);
  const saved = Schema.decodeUnknownSync(CheckpointProof)(await response.json());
  expect(saved.op).toBe("saved");
  if (saved.op !== "saved") return;
  expect(saved.before.kind).toBe("yield");
  await first.dispose();
  const second = instance(directory);
  const resumed = await send(second, { op: "resume", hash: saved.hash });
  expect(resumed.status).toBe(200);
  const proof = Schema.decodeUnknownSync(CheckpointProof)(await resumed.json());
  expect(proof.op).toBe("resumed");
  if (proof.op !== "resumed") return;
  expect(proof.terminal.kind).toBe("done");
  if (proof.terminal.kind === "done") {
    expect(proof.terminal.output.exitCode).toBe(0);
    expect(proof.terminal.output.result).toBe(7);
    expect(proof.terminal.output.stdout).toBe("Aa main\n");
  }
  await second.dispose();
  await rm(directory, { recursive: true, force: true });
}, 15000);
