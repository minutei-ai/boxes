import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Schema } from "effect";
import {
  DirectoryEntries,
  FileContent,
  FileStat,
  RunRecord,
  Status,
  TokenResponse,
  ProcessPage,
} from "../src/contracts";
import { runtime } from "../tooling/runtime";

const directory = await mkdtemp(join(tmpdir(), "cirro-integration-"));
const mf = runtime(directory);
const admin = "cirro-local-test-credential";
const policy = { cpuMs: 1000, maxOutputBytes: 1_048_576, networkHosts: [] };
const post = async (path: string, token: string, body: unknown) =>
  fetch(new URL(path, await mf.ready), {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
const setup = async (
  id: string,
  permissions = ["read", "write", "execute", "network", "manage"],
) => {
  const created = await post("/v1/sandboxes", admin, { id, policy });
  expect(created.status).toBe(201);
  const minted = await post(`/v1/sandboxes/${id}/capabilities`, admin, {
    expiresInSeconds: 3600,
    permissions,
  });
  expect(minted.status).toBe(200);
  return Schema.decodeUnknownSync(TokenResponse)(await minted.json()).token;
};
const act = (id: string, token: string, action: unknown) =>
  post(`/v1/sandboxes/${id}/action`, token, action);

beforeAll(async () => {
  await mf.ready;
});
afterAll(async () => {
  await mf.dispose();
  await rm(directory, { recursive: true, force: true });
});

test("Rust/Wasm filesystem round trips binary blocks through real R2", async () => {
  const token = await setup("blocks");
  const data = Buffer.alloc(700_000, 177);
  const written = await act("blocks", token, {
    op: "filesystem.writeFile",
    path: "/tmp/a.bin",
    content: data.toString("base64"),
    encoding: "base64",
  });
  expect(written.status).toBe(200);
  const response = await act("blocks", token, { op: "filesystem.readFile", path: "/tmp/a.bin" });
  expect(response.status).toBe(200);
  const output = Schema.decodeUnknownSync(FileContent)(await response.json());
  expect(Buffer.from(output.content, "base64")).toEqual(data);
  const stat = await act("blocks", token, {
    op: "filesystem.stat",
    path: "/tmp/a.bin",
    follow: true,
  });
  expect(Schema.decodeUnknownSync(FileStat)(await stat.json()).size).toBe(data.length);
});

test("directories, relative symlinks, rename, removal and chmod keep filesystem invariants", async () => {
  const token = await setup("files");
  expect(
    (await act("files", token, { op: "filesystem.mkdir", path: "/tmp/a/b", recursive: true }))
      .status,
  ).toBe(200);
  expect(
    (
      await act("files", token, {
        op: "filesystem.writeFile",
        path: "/tmp/a/b/x",
        content: "hello",
        encoding: "utf8",
      })
    ).status,
  ).toBe(200);
  expect(
    (await act("files", token, { op: "filesystem.symlink", path: "/tmp/link", target: "a/b/x" }))
      .status,
  ).toBe(200);
  const linked = await act("files", token, { op: "filesystem.readFile", path: "/tmp/link" });
  expect(
    Buffer.from(
      Schema.decodeUnknownSync(FileContent)(await linked.json()).content,
      "base64",
    ).toString(),
  ).toBe("hello");
  expect(
    (await act("files", token, { op: "filesystem.move", from: "/tmp/a", to: "/tmp/moved" })).status,
  ).toBe(200);
  const directory = await act("files", token, { op: "filesystem.readdir", path: "/tmp/moved/b" });
  expect(Schema.decodeUnknownSync(DirectoryEntries)(await directory.json())).toEqual([
    { name: "x", kind: "file" },
  ]);
  expect(
    (await act("files", token, { op: "filesystem.remove", path: "/tmp/moved", recursive: false }))
      .status,
  ).toBe(409);
  expect(
    (await act("files", token, { op: "filesystem.chmod", path: "/tmp/moved/b/x", mode: 0 })).status,
  ).toBe(200);
  expect(
    (await act("files", token, { op: "filesystem.readFile", path: "/tmp/moved/b/x" })).status,
  ).toBe(403);
  expect(
    (await act("files", token, { op: "filesystem.remove", path: "/tmp/link", recursive: false }))
      .status,
  ).toBe(200);
  expect(
    (await act("files", token, { op: "filesystem.remove", path: "/tmp/moved", recursive: true }))
      .status,
  ).toBe(200);
});

test("capability isolation, malformed paths, symlink loops and disposed sandboxes", async () => {
  const token = await setup("one");
  const other = await setup("two");
  expect((await act("two", token, { op: "vm.status" })).status).toBe(401);
  expect((await act("one", `${token}x`, { op: "vm.status" })).status).toBe(401);
  expect(
    (await act("one", token, { op: "filesystem.mkdir", path: "\u0000", recursive: true })).status,
  ).toBe(400);
  expect(
    (await act("one", token, { op: "filesystem.symlink", path: "/tmp/loop", target: "loop" }))
      .status,
  ).toBe(200);
  expect(
    (await act("one", token, { op: "filesystem.stat", path: "/tmp/loop", follow: true })).status,
  ).toBe(400);
  const reader = await setup("reader", ["read"]);
  expect(
    (
      await act("reader", reader, {
        op: "filesystem.writeFile",
        path: "/tmp/x",
        content: "x",
        encoding: "utf8",
      })
    ).status,
  ).toBe(403);
  expect((await act("two", other, { op: "vm.dispose" })).status).toBe(200);
  expect((await act("two", other, { op: "vm.status" })).status).toBe(404);
});

test("concurrent writes publish a consistent filesystem or report a conflict", async () => {
  const token = await setup("race");
  const responses = await Promise.all(
    Array.from({ length: 8 }, (_, i) =>
      act("race", token, {
        op: "filesystem.writeFile",
        path: `/tmp/${i}`,
        content: `${i}`,
        encoding: "utf8",
      }),
    ),
  );
  expect(responses.every((response) => [200, 409].includes(response.status))).toBe(true);
  const listed = await act("race", token, { op: "filesystem.readdir", path: "/tmp" });
  const entries = Schema.decodeUnknownSync(DirectoryEntries)(await listed.json());
  expect(entries.length).toBe(responses.filter((response) => response.status === 200).length);
  const status = await act("race", token, { op: "vm.status" });
  expect(Schema.decodeUnknownSync(Status)(await status.json()).generation).toBe(entries.length);
});

test("dynamic JavaScript executes with scoped host filesystem and durable process result", async () => {
  const token = await setup("js");
  const result = await act("js", token, {
    op: "process.run",
    id: "run-1",
    language: "javascript",
    source: `export default async ({tools, console}) => { await tools.call({op: 'filesystem.writeFile', path: '/tmp/guest', content: 'from guest', encoding: 'utf8'}); console.log('hello cirro'); return 6 * 7; };`,
  });
  expect(result.status).toBe(200);
  const record = Schema.decodeUnknownSync(RunRecord)(await result.json());
  expect(record.status).toBe("exited");
  expect(record.output?.result).toBe(42);
  expect(record.output?.stdout).toBe("hello cirro\n");
  const file = await act("js", token, { op: "filesystem.readFile", path: "/tmp/guest" });
  expect(
    Buffer.from(
      Schema.decodeUnknownSync(FileContent)(await file.json()).content,
      "base64",
    ).toString(),
  ).toBe("from guest");
  const inspected = await act("js", token, { op: "process.get", id: "run-1" });
  expect(Schema.decodeUnknownSync(RunRecord)(await inspected.json())).toEqual(record);
  expect(
    (
      await act("js", token, {
        op: "process.run",
        id: "run-1",
        language: "javascript",
        source: `export default () => 2;`,
      })
    ).status,
  ).toBe(409);
});

test("guest cannot access network or host bindings", async () => {
  const token = await setup("escape");
  const result = await act("escape", token, {
    op: "process.run",
    id: "escape-1",
    language: "javascript",
    source: `import { env } from 'cloudflare:workers'; export default async () => { const bindings = Object.keys(env).sort(); const network = await fetch('https://example.com').then(() => 'escaped', () => 'denied'); return {bindings, network}; };`,
  });
  const record = Schema.decodeUnknownSync(RunRecord)(await result.json());
  expect(record.status).toBe("exited");
  expect(record.output?.result).toEqual({ bindings: ["MAX_OUTPUT", "TOOLS"], network: "denied" });
  expect(
    (await act("escape", token, { op: "network.fetch", url: "https://example.com" })).status,
  ).toBe(403);
});

test("R2 filesystem survives a new workerd instance", async () => {
  const token = await setup("restart");
  expect(
    (
      await act("restart", token, {
        op: "filesystem.writeFile",
        path: "/tmp/persist",
        content: "durable",
        encoding: "utf8",
      })
    ).status,
  ).toBe(200);
  const second = runtime(directory);
  await second.ready;
  const response = await fetch(new URL("/v1/sandboxes/restart/action", await second.ready), {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
    body: JSON.stringify({ op: "filesystem.readFile", path: "/tmp/persist" }),
  });
  const file = Schema.decodeUnknownSync(FileContent)(await response.json());
  expect(Buffer.from(file.content, "base64").toString()).toBe("durable");
  await second.dispose();
});

test("shell pipelines, redirects, conditionals and files execute against the Rust kernel", async () => {
  const token = await setup("shell");
  const result = await act("shell", token, {
    op: "process.run",
    id: "shell-1",
    language: "shell",
    source:
      "mkdir -p /tmp/work && cd /tmp/work; echo 'hello cirro' > a; cat a | grep cirro > b; false && echo wrong; true || echo wrong; cat b; pwd",
  });
  expect(result.status).toBe(200);
  const record = Schema.decodeUnknownSync(RunRecord)(await result.json());
  expect(record.status).toBe("exited");
  expect(record.output?.stdout).toBe("hello cirro\n/tmp/work\n");
  expect(record.output?.exitCode).toBe(0);
  const file = await act("shell", token, { op: "filesystem.readFile", path: "/tmp/work/b" });
  expect(
    Buffer.from(
      Schema.decodeUnknownSync(FileContent)(await file.json()).content,
      "base64",
    ).toString(),
  ).toBe("hello cirro\n");
});

test("Python executes through the native Dynamic Worker runtime", async () => {
  const token = await setup("python");
  const result = await act("python", token, {
    op: "process.run",
    id: "python-1",
    language: "python",
    source: "async def main(tools):\n    return 6 * 7\n",
  });
  expect(result.status).toBe(200);
  const record = Schema.decodeUnknownSync(RunRecord)(await result.json());
  expect(record.status).toBe("exited");
  expect(record.output?.result).toBe(42);
}, 60_000);

test("append and truncate preserve binary sizes, permissions and empty files", async () => {
  const token = await setup("truncate");
  expect(
    (
      await act("truncate", token, {
        op: "filesystem.writeFile",
        path: "/tmp/a",
        content: "one",
        encoding: "utf8",
      })
    ).status,
  ).toBe(200);
  expect(
    (await act("truncate", token, { op: "filesystem.appendFile", path: "/tmp/a", content: "two" }))
      .status,
  ).toBe(200);
  expect(
    (await act("truncate", token, { op: "filesystem.truncate", path: "/tmp/a", size: 8 })).status,
  ).toBe(200);
  const enlarged = Schema.decodeUnknownSync(FileContent)(
    await (await act("truncate", token, { op: "filesystem.readFile", path: "/tmp/a" })).json(),
  );
  expect(Buffer.from(enlarged.content, "base64")).toEqual(
    Buffer.from([111, 110, 101, 116, 119, 111, 0, 0]),
  );
  expect(
    (await act("truncate", token, { op: "filesystem.truncate", path: "/tmp/a", size: 0 })).status,
  ).toBe(200);
  const empty = Schema.decodeUnknownSync(FileContent)(
    await (await act("truncate", token, { op: "filesystem.readFile", path: "/tmp/a" })).json(),
  );
  expect(empty.size).toBe(0);
  expect(empty.content).toBe("");
  expect(
    (
      await act("truncate", token, {
        op: "filesystem.writeFile",
        path: "/tmp/b",
        content: "%%%",
        encoding: "base64",
      })
    ).status,
  ).toBe(400);
});

test("Python can persist a file through its scoped RPC capability", async () => {
  const token = await setup("python-files");
  const result = await act("python-files", token, {
    op: "process.run",
    id: "write-1",
    language: "python",
    source:
      "from pyodide.ffi import to_js\nasync def main(tools):\n    await tools.call(to_js({'op': 'filesystem.writeFile', 'path': '/tmp/python', 'content': 'python persisted', 'encoding': 'utf8'}))\n    return 'ok'\n",
  });
  const record = Schema.decodeUnknownSync(RunRecord)(await result.json());
  expect(record.status).toBe("exited");
  expect(record.output?.result).toBe("ok");
  const file = Schema.decodeUnknownSync(FileContent)(
    await (
      await act("python-files", token, { op: "filesystem.readFile", path: "/tmp/python" })
    ).json(),
  );
  expect(Buffer.from(file.content, "base64").toString()).toBe("python persisted");
}, 60_000);

test("guest output limit persists a failed run and does not rerun uncertain side effects", async () => {
  expect(
    (
      await post("/v1/sandboxes", admin, {
        id: "output-limit",
        policy: { ...policy, maxOutputBytes: 1024 },
      })
    ).status,
  ).toBe(201);
  const minted = await post("/v1/sandboxes/output-limit/capabilities", admin, {
    permissions: ["read", "write", "execute"],
    expiresInSeconds: 3600,
  });
  const token = Schema.decodeUnknownSync(TokenResponse)(await minted.json()).token;
  const result = await act("output-limit", token, {
    op: "process.run",
    id: "large",
    language: "javascript",
    source: `export default async ({tools}) => { await tools.call({op:'filesystem.writeFile',path:'/tmp/before',content:'committed',encoding:'utf8'}); return 'x'.repeat(2000); };`,
  });
  expect(Schema.decodeUnknownSync(RunRecord)(await result.json()).status).toBe("failed");
  const file = await act("output-limit", token, { op: "filesystem.readFile", path: "/tmp/before" });
  expect(file.status).toBe(200);
  expect(
    (
      await act("output-limit", token, {
        op: "process.run",
        id: "large",
        language: "javascript",
        source: "export default () => 42;",
      })
    ).status,
  ).toBe(409);
});

test("compiled Rust guest executes as an isolated native Wasm module", async () => {
  const token = await setup("wasm");
  const module = await Bun.file(new URL("../dist/guest-test.wasm", import.meta.url)).arrayBuffer();
  const result = await act("wasm", token, {
    op: "process.run",
    id: "wasm-1",
    language: "wasm",
    source: Buffer.from(module).toString("base64"),
  });
  const record = Schema.decodeUnknownSync(RunRecord)(await result.json());
  expect(record.status).toBe("exited");
  expect(record.output?.result).toBe(42);
  expect(record.language).toBe("wasm");
});

test("configuration updates require management and preserve files", async () => {
  const token = await setup("config");
  expect(
    (
      await act("config", token, {
        op: "filesystem.writeFile",
        path: "/tmp/a",
        content: "preserved",
        encoding: "utf8",
      })
    ).status,
  ).toBe(200);
  expect((await act("config", token, { op: "config.patch", policy: { cpuMs: 2000 } })).status).toBe(
    200,
  );
  const status = Schema.decodeUnknownSync(Status)(
    await (await act("config", token, { op: "vm.status" })).json(),
  );
  expect(status.policy.cpuMs).toBe(2000);
  expect(status.policy.maxOutputBytes).toBe(policy.maxOutputBytes);
  const file = await act("config", token, { op: "filesystem.readFile", path: "/tmp/a" });
  expect(file.status).toBe(200);
  const minted = await post("/v1/sandboxes/config/capabilities", admin, {
    permissions: ["read", "write"],
    expiresInSeconds: 3600,
  });
  const restricted = Schema.decodeUnknownSync(TokenResponse)(await minted.json()).token;
  expect((await act("config", restricted, { op: "config.set", policy })).status).toBe(403);
  expect((await act("config", restricted, { op: "vm.dispose" })).status).toBe(403);
  expect((await act("config", token, { op: "config.patch", policy: { cpuMs: 0 } })).status).toBe(
    400,
  );
});

test("existing file writes obey file mode instead of requiring a writable parent", async () => {
  const token = await setup("permissions");
  expect(
    (
      await act("permissions", token, {
        op: "filesystem.mkdir",
        path: "/tmp/locked",
        recursive: false,
      })
    ).status,
  ).toBe(200);
  expect(
    (
      await act("permissions", token, {
        op: "filesystem.writeFile",
        path: "/tmp/locked/a",
        content: "first",
        encoding: "utf8",
      })
    ).status,
  ).toBe(200);
  expect(
    (await act("permissions", token, { op: "filesystem.chmod", path: "/tmp/locked", mode: 365 }))
      .status,
  ).toBe(200);
  expect(
    (
      await act("permissions", token, {
        op: "filesystem.writeFile",
        path: "/tmp/locked/a",
        content: "second",
        encoding: "utf8",
      })
    ).status,
  ).toBe(200);
  expect(
    (
      await act("permissions", token, {
        op: "filesystem.writeFile",
        path: "/tmp/locked/new",
        content: "second",
        encoding: "utf8",
      })
    ).status,
  ).toBe(403);
});

test("maximum file size and total quota are enforced by the real Wasm kernel", async () => {
  const token = await setup("quota");
  const content = "q".repeat(16_777_216);
  expect(
    (
      await act("quota", token, {
        op: "filesystem.writeFile",
        path: "/tmp/a",
        content,
        encoding: "utf8",
      })
    ).status,
  ).toBe(200);
  const size = Schema.decodeUnknownSync(FileStat)(
    await (
      await act("quota", token, { op: "filesystem.stat", path: "/tmp/a", follow: true })
    ).json(),
  ).size;
  expect(size).toBe(16_777_216);
  for (const path of ["/tmp/b", "/tmp/c", "/tmp/d"]) {
    expect(
      (await act("quota", token, { op: "filesystem.writeFile", path, content, encoding: "utf8" }))
        .status,
    ).toBe(200);
  }
  expect(
    (
      await act("quota", token, {
        op: "filesystem.writeFile",
        path: "/tmp/over",
        content: "q",
        encoding: "utf8",
      })
    ).status,
  ).toBe(413);
  expect(
    (
      await act("quota", token, {
        op: "filesystem.writeFile",
        path: "/tmp/a",
        content: `${content}q`,
        encoding: "utf8",
      })
    ).status,
  ).toBe(413);
}, 60_000);

test("unknown request fields and unsupported operations fail instead of being ignored", async () => {
  const token = await setup("strict");
  expect(
    (await act("strict", token, { op: "filesystem.readdir", path: "/tmp", limit: 1 })).status,
  ).toBe(400);
  expect((await act("strict", token, { op: "process.spawn", command: "node" })).status).toBe(400);
  const result = await act("strict", token, {
    op: "process.run",
    id: "host-forgery",
    language: "javascript",
    source: `export default async ({tools}) => tools.call({op:'vm.dispose'});`,
  });
  expect(Schema.decodeUnknownSync(RunRecord)(await result.json()).status).toBe("failed");
  expect((await act("strict", token, { op: "vm.status" })).status).toBe(200);
});

test("corrupt R2 content is rejected before unbounded body allocation", async () => {
  const token = await setup("corrupt");
  expect(
    (
      await act("corrupt", token, {
        op: "filesystem.writeFile",
        path: "/tmp/a",
        content: "abc",
        encoding: "utf8",
      })
    ).status,
  ).toBe(200);
  const digest = Buffer.from(await crypto.subtle.digest("SHA-256", Buffer.from("abc"))).toString(
    "hex",
  );
  const bucket = await mf.getR2Bucket("OBJECTS");
  await bucket.put(`sandboxes/corrupt/blobs/${digest}`, "oversized");
  expect((await act("corrupt", token, { op: "filesystem.readFile", path: "/tmp/a" })).status).toBe(
    500,
  );
  await bucket.put(`sandboxes/corrupt/blobs/${digest}`, "xyz");
  expect((await act("corrupt", token, { op: "filesystem.readFile", path: "/tmp/a" })).status).toBe(
    500,
  );
});

test("process pagination consumes native cursors and lists metadata without outputs", async () => {
  const token = await setup("page");
  for (const id of ["a", "b", "c"]) {
    const response = await act("page", token, {
      op: "process.run",
      id,
      language: "shell",
      source: "echo result",
    });
    expect(Schema.decodeUnknownSync(RunRecord)(await response.json()).status).toBe("exited");
  }
  const first = Schema.decodeUnknownSync(ProcessPage)(
    await (await act("page", token, { op: "process.list", limit: 2, cursor: null })).json(),
  );
  expect(first.items.map((item) => item.id)).toEqual(["a", "b"]);
  expect(first.items.every((item) => item.status === "exited")).toBe(true);
  expect(first.cursor).not.toBeNull();
  const second = Schema.decodeUnknownSync(ProcessPage)(
    await (await act("page", token, { op: "process.list", limit: 2, cursor: first.cursor })).json(),
  );
  expect(second.items.map((item) => item.id)).toEqual(["c"]);
  expect(second.cursor).toBeNull();
});
