import { afterAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Schema } from "effect";
import { Head, Id } from "../src/contracts";
import { DriverAbortProof, DriverProof } from "./fixtures/sdk-binding-worker";
import { runtime } from "../tooling/worker-test";

const directory = await mkdtemp(join(tmpdir(), "boxes-tanstack-"));
const worker = runtime(directory, { binding: true });
afterAll(async () => {
  await worker.dispose();
  await rm(directory, { recursive: true, force: true });
});
test("native driver rejects preflight abort and stops pending work while preserving an earlier confirmed write", async () => {
  const url = await worker.binding();
  url.searchParams.set("driver", "abort");
  const response = await fetch(url, {
    method: "POST",
    body: Schema.encodeSync(Schema.fromJsonString(Id))("driver-abort"),
  });
  expect(response.status).toBe(200);
  const proof = Schema.decodeUnknownSync(DriverAbortProof)(await response.json());
  expect([proof.preflight, proof.cancelled]).toEqual(["AbortError", "AbortError"]);
  expect(proof.writes).toEqual(["confirmed"]);
});
test("native driver preserves callbacks, void values, context reuse and disposal through a service binding", async () => {
  const url = await worker.binding();
  url.searchParams.set("driver", "true");
  const response = await fetch(url, {
    method: "POST",
    body: Schema.encodeSync(Schema.fromJsonString(Id))("driver"),
  });
  expect(response.status).toBe(200);
  const proof = Schema.decodeUnknownSync(DriverProof)(await response.json());
  expect(proof.values).toEqual(["confirmed", true]);
  expect(proof.scratch).toEqual({ content: "Mgo=", encoding: "base64", size: 2 });
  expect(proof.voidResult).toBe(true);
  expect(proof.writes).toEqual(["confirmed"]);
  expect(proof.closed).toBe(true);
  const objects = await worker.objects;
  const page = await objects.list({ prefix: "sandboxes/context-" });
  const roots = page.objects.filter((object) => object.key.endsWith("/head.json"));
  expect(roots.length).toBeGreaterThan(0);
  for (const root of roots) {
    const object = await objects.get(root.key);
    if (object === null) return expect(object).not.toBeNull();
    expect(Schema.decodeUnknownSync(Schema.fromJsonString(Head))(await object.text()).deleted).toBe(
      true,
    );
  }
});
