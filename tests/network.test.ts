import { afterAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Schema } from "effect";
import { NetworkResult, RunRecord, TokenResponse } from "../src/contracts";
import { runtime } from "../tooling/worker-test";

const directory = await mkdtemp(join(tmpdir(), "cirro-network-"));
const mf = runtime(directory, { consume: true, controlled: false, origin: { delay: 0, body: "" } });
const policy = {
  networkHosts: ["allowed.example"],
  interruptBudget: 1000,
  memoryBytes: 8_388_608,
  maxOutputBytes: 1024,
};
const post = async (path: string, token: string, body: unknown) =>
  fetch(new URL(path, await mf.ready), {
    method: "POST",
    keepalive: false,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
const setup = async (id: string, permissions = ["read", "network", "execute"]) => {
  expect((await post("/v1/sandboxes", "cirro-local-test-credential", { id, policy })).status).toBe(
    201,
  );
  return Schema.decodeUnknownSync(TokenResponse)(
    await (
      await post(`/v1/sandboxes/${id}/capabilities`, "cirro-local-test-credential", {
        expiresInSeconds: 3600,
        permissions,
      })
    ).json(),
  ).token;
};
const action = (id: string, token: string, body: unknown) =>
  post(`/v1/sandboxes/${id}/action`, token, body);
const Echo = Schema.Struct({
  method: Schema.String,
  header: Schema.NullOr(Schema.String),
  auth: Schema.NullOr(Schema.String),
  body: Schema.Array(Schema.Number),
  url: Schema.String,
});
const echo = (result: typeof NetworkResult.Type) =>
  Schema.decodeUnknownSync(Schema.fromJsonString(Echo))(
    Buffer.from(result.content, "base64").toString(),
  );
afterAll(async () => {
  await mf.dispose();
  await rm(directory, { recursive: true, force: true });
});

test("HTTP methods, binary bodies and response headers traverse native Workers", async () => {
  const token = await setup("http-methods");
  for (const method of ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]) {
    const response = await action("http-methods", token, {
      op: "network.fetch",
      url: "https://allowed.example/echo",
      method,
      headers: { "X-Agent": "cirro" },
    });
    expect(response.status).toBe(200);
    const result = Schema.decodeUnknownSync(NetworkResult)(await response.json());
    expect(result.status).toBe(201);
    expect(result.headers["x-origin"]).toBe("native-workerd");
    expect(echo(result)).toEqual({
      method,
      header: "cirro",
      auth: null,
      body: [],
      url: "https://allowed.example/echo",
    });
  }
  const sent = Schema.decodeUnknownSync(NetworkResult)(
    await (
      await action("http-methods", token, {
        op: "network.fetch",
        url: "https://allowed.example/echo",
        method: "POST",
        headers: { authorization: "Bearer upstream-token" },
        body: { content: "AAH/gA==", encoding: "base64" },
      })
    ).json(),
  );
  expect(echo(sent).body).toEqual([0, 1, 255, 128]);
  expect(echo(sent).auth).toBe("Bearer upstream-token");
  const head = Schema.decodeUnknownSync(NetworkResult)(
    await (
      await action("http-methods", token, {
        op: "network.fetch",
        url: "https://allowed.example/echo",
        method: "HEAD",
      })
    ).json(),
  );
  expect(head.status).toBe(201);
  expect(head.content).toBe("");
});

test("HTTP grants, destination policy and transport headers cannot be bypassed", async () => {
  const token = await setup("http-denied");
  const origin = await mf.origin();
  const before = Schema.decodeUnknownSync(Schema.Number)(
    await (await fetch(new URL("/count", origin))).json(),
  );
  for (const url of [
    "https://forbidden.example/echo",
    "http://allowed.example/echo",
    "https://user:pass@allowed.example/echo",
    "https://allowed.example:444/echo",
    "https://127.0.0.1/echo",
  ]) {
    expect(
      (await action("http-denied", token, { op: "network.fetch", url, method: "POST" })).status,
    ).toBe(403);
  }
  for (const name of ["Host", "Content-Length", "Transfer-Encoding", "Connection", "Upgrade"]) {
    expect(
      (
        await action("http-denied", token, {
          op: "network.fetch",
          url: "https://allowed.example/echo",
          headers: { [name]: "forbidden.example" },
        })
      ).status,
    ).toBe(400);
  }
  const noNetwork = await setup("http-no-grant", ["read"]);
  expect(
    (
      await action("http-no-grant", noNetwork, {
        op: "network.fetch",
        url: "https://allowed.example/echo",
        method: "POST",
      })
    ).status,
  ).toBe(403);
  expect(
    Schema.decodeUnknownSync(Schema.Number)(await (await fetch(new URL("/count", origin))).json()),
  ).toBe(before);
});

test("malformed HTTP inputs fail before outbound requests", async () => {
  const token = await setup("http-input");
  const origin = await mf.origin();
  const before = Schema.decodeUnknownSync(Schema.Number)(
    await (await fetch(new URL("/count", origin))).json(),
  );
  for (const input of [
    { method: "TRACE" },
    { method: "CONNECT" },
    { method: "GET", body: { content: "x", encoding: "utf8" } },
    { method: "HEAD", body: { content: "", encoding: "utf8" } },
    { method: "POST", body: { content: "AB==", encoding: "base64" } },
    { headers: { "x-agent": "injected\r\nHost: forbidden.example" } },
    { headers: { "x-agent": "\u0100" } },
    { headers: Object.fromEntries(Array.from({ length: 129 }, (_, index) => [`x-${index}`, "v"])) },
  ]) {
    expect(
      (
        await action("http-input", token, {
          op: "network.fetch",
          url: "https://allowed.example/echo",
          ...input,
        })
      ).status,
    ).toBeGreaterThanOrEqual(400);
  }
  const oversized = await action("http-input", token, {
    op: "network.fetch",
    url: "https://allowed.example/echo",
    method: "POST",
    body: { content: "é".repeat(524289), encoding: "utf8" },
  });
  expect(oversized.status).toBe(413);
  expect(
    Schema.decodeUnknownSync(Schema.Number)(await (await fetch(new URL("/count", origin))).json()),
  ).toBe(before);
});

test("redirects remain visible and oversized responses fail", async () => {
  const token = await setup("http-response");
  const result = Schema.decodeUnknownSync(NetworkResult)(
    await (
      await action("http-response", token, {
        op: "network.fetch",
        url: "https://allowed.example/redirect",
        method: "POST",
        body: { content: "payload", encoding: "utf8" },
      })
    ).json(),
  );
  expect(result.status).toBe(307);
  expect(result.headers.location).toBe("https://forbidden.example/echo");
  for (const path of ["large", "large-header"])
    expect(
      (
        await action("http-response", token, {
          op: "network.fetch",
          url: `https://allowed.example/${path}`,
        })
      ).status,
    ).toBe(413);
});

test("JavaScript and Python use the same authorized HTTP request contract", async () => {
  const token = await setup("http-guests");
  const sources = {
    javascript:
      'export default async ({tools}) => await tools.call({op:"network.fetch",url:"https://allowed.example/echo",method:"POST",headers:{"x-agent":"guest"},body:{content:"hello",encoding:"utf8"}})',
    python:
      '(await tools.call({"op":"network.fetch","url":"https://allowed.example/echo","method":"POST","headers":{"x-agent":"guest"},"body":{"content":"hello","encoding":"utf8"}}))',
  };
  for (const [language, source] of Object.entries(sources)) {
    const response = await action("http-guests", token, {
      op: "process.run",
      id: language,
      language,
      source,
    });
    expect(response.status).toBe(200);
    const record = Schema.decodeUnknownSync(RunRecord)(await response.json());
    expect(record.output?.exitCode).toBe(0);
    const result = Schema.decodeUnknownSync(NetworkResult)(record.output?.result);
    expect(echo(result).header).toBe("guest");
    expect(echo(result).body).toEqual(Array.from(Buffer.from("hello")));
    expect(echo(result).auth).toBeNull();
  }
});

test("HTTP accepts the exact 1 MiB request boundary and rejects aggregate header overflow", async () => {
  const token = await setup("http-boundaries");
  const response = await action("http-boundaries", token, {
    op: "network.fetch",
    url: "https://allowed.example/accepted",
    method: "POST",
    body: { content: Buffer.alloc(1_048_576, 255).toString("base64"), encoding: "base64" },
  });
  expect(response.status).toBe(200);
  const result = Schema.decodeUnknownSync(NetworkResult)(await response.json());
  expect(Buffer.from(result.content, "base64").toString()).toBe("1048576");
  expect(
    (
      await action("http-boundaries", token, {
        op: "network.fetch",
        url: "https://allowed.example/accepted",
        headers: Object.fromEntries(
          Array.from({ length: 9 }, (_, index) => [`x-${index}`, "a".repeat(8192)]),
        ),
      })
    ).status,
  ).toBe(413);
});
