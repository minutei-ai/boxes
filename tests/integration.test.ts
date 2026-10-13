import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Schema, Struct } from "effect";
import {
  DirectoryEntries,
  PackagePreparation,
  SoftwareCatalog,
  BatchReadResults,
  BatchWriteResults,
  DirectoryTree,
  CanonicalPath,
  FileContent,
  FileStat,
  RunRecord,
  Status,
  TokenResponse,
  ProcessPage,
  Head,
  MigrationReceipt,
  ScriptProgram,
  WasmProgram,
  RunMetadata,
} from "../src/contracts";
import { runtime } from "../tooling/runtime";
import { commandPackage } from "./fixtures/package";

const directory = await mkdtemp(join(tmpdir(), "cirro-integration-"));
const mf = runtime(directory);
const admin = "cirro-local-test-credential";
const policy = {
  interruptBudget: 1000,
  memoryBytes: 8_388_608,
  maxOutputBytes: 1_048_576,
  networkHosts: [],
};
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

test("compiled Rust WASI reads, writes, seeks and syncs through native R2", async () => {
  const token = await setup("wasi");
  const source = Buffer.from(
    await Bun.file(join(import.meta.dir, "../dist/wasi-test.wasm")).arrayBuffer(),
  ).toString("base64");
  const response = await act("wasi", token, {
    op: "process.run",
    id: "wasi",
    language: "wasm",
    source,
  });
  expect(response.status).toBe(200);
  const record = Schema.decodeUnknownSync(RunRecord)(await response.json());
  expect(record.status).toBe("exited");
  expect(record.output?.exitCode).toBe(0);
  expect(record.output?.stdout).toBe("persistent WASI\n");
  const file = Schema.decodeUnknownSync(FileContent)(
    await (await act("wasi", token, { op: "filesystem.readFile", path: "/tmp/wasi-file" })).json(),
  );
  expect(Buffer.from(file.content, "base64").toString()).toBe("persistent WASI");
});

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
  const listed = Schema.decodeUnknownSync(DirectoryEntries)(await directory.json());
  expect(listed.map((entry) => ({ name: entry.name, kind: entry.kind }))).toEqual([
    { name: "x", kind: "file" },
  ]);
  expect(listed[0]?.inode).toBeGreaterThan(0);
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

test("Rust QuickJS executes with scoped host filesystem and durable process result", async () => {
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

test("guest CPU and memory exhaustion preserve Worker health and isolation", async () => {
  const token = await setup("limits");
  const looping = Schema.decodeUnknownSync(RunRecord)(
    await (
      await act("limits", token, {
        op: "process.run",
        id: "loop",
        language: "javascript",
        source: "export default () => { while(true) {} };",
      })
    ).json(),
  );
  expect(looping.status).toBe("failed");
  const allocation = Schema.decodeUnknownSync(RunRecord)(
    await (
      await act("limits", token, {
        op: "process.run",
        id: "memory",
        language: "javascript",
        source: "export default () => Array(10000000).fill('memory');",
      })
    ).json(),
  );
  expect(allocation.output?.exitCode).toBe(1);
  expect(allocation.output?.stderr).toContain("out of memory");
  const first = Schema.decodeUnknownSync(RunRecord)(
    await (
      await act("limits", token, {
        op: "process.run",
        id: "state-first",
        language: "javascript",
        source: "export default () => { globalThis.secret='private'; return 42; };",
      })
    ).json(),
  );
  expect(first.output?.result).toBe(42);
  const second = Schema.decodeUnknownSync(RunRecord)(
    await (
      await act("limits", token, {
        op: "process.run",
        id: "state-second",
        language: "javascript",
        source: "export default () => typeof globalThis.secret;",
      })
    ).json(),
  );
  expect(second.output?.result).toBe("undefined");
  expect((await act("limits", token, { op: "vm.status" })).status).toBe(200);
});

test("native platform imports fail inside QuickJS while the Worker remains available", async () => {
  const token = await setup("imports");
  const imported = await act("imports", token, {
    op: "process.run",
    id: "cloudflare",
    language: "javascript",
    source: "import {env} from 'cloudflare:workers'; export default () => env;",
  });
  expect(imported.status).toBe(422);
  expect((await act("imports", token, { op: "process.get", id: "cloudflare" })).status).toBe(404);
  expect((await act("imports", token, { op: "vm.status" })).status).toBe(200);
});

test("script execution and evaluation expose scoped globals without requiring a default export", async () => {
  const token = await setup("scripts");
  const executed = Schema.decodeUnknownSync(RunRecord)(
    await (
      await act("scripts", token, {
        op: "javascript.execute",
        id: "execute",
        source:
          "console.log('script started'); await tools.call({op:'filesystem.writeFile',path:'/tmp/started',content:'42',encoding:'utf8'});",
      })
    ).json(),
  );
  expect(executed.output?.stdout).toBe("script started\n");
  expect(executed.output?.result).toBeNull();
  const evaluated = Schema.decodeUnknownSync(RunRecord)(
    await (
      await act("scripts", token, {
        op: "typescript.evaluate",
        id: "evaluate",
        expression: "(40 as number)+2",
      })
    ).json(),
  );
  expect(evaluated.output?.result).toBe(42);
  const fault = Schema.decodeUnknownSync(RunRecord)(
    await (
      await act("scripts", token, {
        op: "javascript.evaluate",
        id: "fault",
        expression:
          "tools.call({op:'filesystem.readFile',path:'/missing'}).catch(error => ({code:error.code,message:error.message}))",
      })
    ).json(),
  );
  expect(
    Schema.is(Schema.Struct({ code: Schema.Literal("ENOENT"), message: Schema.String }))(
      fault.output?.result,
    ),
  ).toBe(true);
});

test("sandbox module graphs resolve TypeScript, reexports, cycles, symlinks and literal dynamic imports", async () => {
  const token = await setup("module-graph");
  const files = [
    ["/tmp/value.ts", "export const answer: number = 42;"],
    ["/tmp/bridge.mjs", "export {answer} from './value.ts';"],
    ["/tmp/a.mjs", "import {b} from './b.mjs'; export function a(){return b();}"],
    ["/tmp/b.mjs", "import {a} from './a.mjs'; export function b(){return a.name.length+41;}"],
    [
      "/tmp/main.mjs",
      "import {answer} from './bridge.mjs'; import {a} from './a.mjs'; import {answer as linked} from './linked.ts'; const dynamic = await import('./value.ts'); console.log(answer,a(),linked,dynamic.answer);",
    ],
  ];
  for (const [path, content] of files)
    expect(
      (
        await act("module-graph", token, {
          op: "filesystem.writeFile",
          path,
          content,
          encoding: "utf8",
        })
      ).status,
    ).toBe(200);
  expect(
    (
      await act("module-graph", token, {
        op: "filesystem.symlink",
        path: "/tmp/linked.ts",
        target: "value.ts",
      })
    ).status,
  ).toBe(200);
  const executed = Schema.decodeUnknownSync(RunRecord)(
    await (
      await act("module-graph", token, {
        op: "javascript.executeFile",
        id: "graph",
        path: "/tmp/main.mjs",
      })
    ).json(),
  );
  expect(executed.output?.stdout).toBe("42 42 42 42\n");
  const bucket = await mf.getR2Bucket("OBJECTS");
  const artifact = await bucket.get(`sandboxes/module-graph/code/${executed.sourceHash}`);
  if (artifact === null) return expect(artifact).not.toBeNull();
  const graph = Schema.decodeUnknownSync(Schema.fromJsonString(ScriptProgram))(
    await artifact.text(),
  );
  expect(graph.modules.length).toBe(5);
  expect(graph.modules.filter((module) => module.name === "/tmp/value.ts").length).toBe(1);
});

test("module source snapshots survive guest writes and a subsequent execution loads the new revision", async () => {
  const token = await setup("module-reload");
  expect(
    (
      await act("module-reload", token, {
        op: "filesystem.writeFile",
        path: "/tmp/value.ts",
        content: "export const answer: number = 42;",
        encoding: "utf8",
      })
    ).status,
  ).toBe(200);
  expect(
    (
      await act("module-reload", token, {
        op: "filesystem.writeFile",
        path: "/tmp/main.ts",
        content:
          "import {answer} from './value.ts'; console.log(answer); await tools.call({op:'filesystem.writeFile',path:'/tmp/value.ts',content:'export const answer: number = 99;',encoding:'utf8'});",
        encoding: "utf8",
      })
    ).status,
  ).toBe(200);
  const first = Schema.decodeUnknownSync(RunRecord)(
    await (
      await act("module-reload", token, {
        op: "typescript.executeFile",
        id: "first",
        path: "/tmp/main.ts",
      })
    ).json(),
  );
  expect(first.output?.stdout).toBe("42\n");
  const second = Schema.decodeUnknownSync(RunRecord)(
    await (
      await act("module-reload", token, {
        op: "typescript.executeFile",
        id: "second",
        path: "/tmp/main.ts",
      })
    ).json(),
  );
  expect(second.output?.stdout).toBe("99\n");
  expect(second.sourceHash).not.toBe(first.sourceHash);
});

test("module loading respects permissions and rejects missing or malformed static imports before reserving a run", async () => {
  const token = await setup("module-errors");
  expect(
    (
      await act("module-errors", token, {
        op: "filesystem.writeFile",
        path: "/tmp/secret.mjs",
        content: "export const secret=42;",
        encoding: "utf8",
      })
    ).status,
  ).toBe(200);
  expect(
    (
      await act("module-errors", token, {
        op: "filesystem.chmod",
        path: "/tmp/secret.mjs",
        mode: 0,
      })
    ).status,
  ).toBe(200);
  expect(
    (
      await act("module-errors", token, {
        op: "javascript.execute",
        id: "denied",
        source: "import {secret} from './secret.mjs'; console.log(secret);",
      })
    ).status,
  ).toBe(403);
  expect(
    (
      await act("module-errors", token, {
        op: "javascript.execute",
        id: "missing",
        source: "import './missing.mjs';",
      })
    ).status,
  ).toBe(422);
  const denied = Schema.decodeUnknownSync(RunRecord)(
    await (
      await act("module-errors", token, {
        op: "javascript.execute",
        id: "computed",
        source: "const name='./secret.mjs'; await import(name);",
      })
    ).json(),
  );
  expect(denied.output?.exitCode).toBe(1);
  expect(denied.output?.stderr).toContain("EACCES");
  expect(
    (
      await act("module-errors", token, {
        op: "javascript.execute",
        id: "syntax",
        source: "const = ;",
      })
    ).status,
  ).toBe(422);
  expect((await act("module-errors", token, { op: "process.get", id: "syntax" })).status).toBe(404);
  const restricted = Schema.decodeUnknownSync(TokenResponse)(
    await (
      await post("/v1/sandboxes/module-errors/capabilities", admin, {
        permissions: ["execute"],
        expiresInSeconds: 3600,
      })
    ).json(),
  ).token;
  expect(
    (
      await act("module-errors", restricted, {
        op: "javascript.executeFile",
        id: "restricted",
        path: "/tmp/secret.mjs",
      })
    ).status,
  ).toBe(403);
  const plain = Schema.decodeUnknownSync(RunRecord)(
    await (
      await act("module-errors", restricted, {
        op: "javascript.evaluate",
        id: "plain",
        expression: "40+2",
      })
    ).json(),
  );
  expect(plain.output?.result).toBe(42);
});

test("compiler stack exhaustion cannot poison subsequent compilation in the same Worker", async () => {
  const token = await setup("compiler-lifetime");
  const expression = "(".repeat(10000) + "42" + ")".repeat(10000);
  for (const id of ["first", "second", "third"]) {
    expect(
      (await act("compiler-lifetime", token, { op: "javascript.evaluate", id, expression })).status,
    ).toBe(422);
    const recovered = Schema.decodeUnknownSync(RunRecord)(
      await (
        await act("compiler-lifetime", token, {
          op: "typescript.evaluate",
          id: `${id}-recovered`,
          expression: "(40 as number)+2",
        })
      ).json(),
    );
    expect(recovered.output?.result).toBe(42);
  }
});

test("computed imports load files created during execution and preserve ESM functions, cache and archived source", async () => {
  const token = await setup("lazy-created");
  const executed = Schema.decodeUnknownSync(RunRecord)(
    await (
      await act("lazy-created", token, {
        op: "javascript.execute",
        id: "created",
        source:
          "const path='/tmp/created.ts'; await tools.call({op:'filesystem.writeFile',path,content:'export function answer(): number {return 42;}',encoding:'utf8'}); const [first,second]=await Promise.all([import(path),import(path)]); console.log(first.answer(),first===second); await tools.call({op:'filesystem.writeFile',path,content:'export function answer(): number {return 99;}',encoding:'utf8'}); const cached=await import(path); console.log(cached.answer());",
      })
    ).json(),
  );
  expect(executed.output?.stdout).toBe("42 true\n42\n");
  const bucket = await mf.getR2Bucket("OBJECTS");
  const artifact = await bucket.get(`sandboxes/lazy-created/code/${executed.sourceHash}`);
  if (artifact === null) return expect(artifact).not.toBeNull();
  const graph = Schema.decodeUnknownSync(Schema.fromJsonString(ScriptProgram))(
    await artifact.text(),
  );
  expect(graph.modules.length).toBe(2);
  expect(
    graph.modules.some(
      (module) => module.name === "/tmp/created.ts" && module.source.includes("42"),
    ),
  ).toBe(true);
  expect(
    graph.modules
      .filter((module) => module.name === "/tmp/created.ts")
      .every((module) => !module.source.includes("return 99;")),
  ).toBe(true);
});

test("literal imports are lazy, recover from missing modules and preserve primitive evaluation failures", async () => {
  const token = await setup("lazy-failure");
  const executed = Schema.decodeUnknownSync(RunRecord)(
    await (
      await act("lazy-failure", token, {
        op: "javascript.execute",
        id: "retry",
        source:
          "if(false) await import('./never.mjs'); const missing=await import('./later.mjs').catch(error=>error.code); console.log(missing); await tools.call({op:'filesystem.writeFile',path:'/tmp/later.mjs',content:'export const value=42;',encoding:'utf8'}); console.log((await import('./later.mjs')).value); await tools.call({op:'filesystem.writeFile',path:'/tmp/boom.mjs',content:'throw \\\"primitive boom\\\";',encoding:'utf8'}); const failure=await import('./boom.mjs').catch(error=>error); console.log(failure);",
      })
    ).json(),
  );
  expect(executed.output?.stdout).toBe("MODULE_NOT_FOUND\n42\nprimitive boom\n");
});

test("computed imports cannot bypass read permissions or platform boundaries", async () => {
  const token = await setup("lazy-permission", ["execute"]);
  const executed = Schema.decodeUnknownSync(RunRecord)(
    await (
      await act("lazy-permission", token, {
        op: "javascript.evaluate",
        id: "denied",
        expression: "import('/tmp/private.mjs').catch(error=>error.code)",
      })
    ).json(),
  );
  expect(executed.output?.result).toBe("FORBIDDEN");
  const full = Schema.decodeUnknownSync(TokenResponse)(
    await (
      await post("/v1/sandboxes/lazy-permission/capabilities", admin, {
        permissions: ["execute", "read"],
        expiresInSeconds: 3600,
      })
    ).json(),
  ).token;
  const platform = Schema.decodeUnknownSync(RunRecord)(
    await (
      await act("lazy-permission", full, {
        op: "javascript.evaluate",
        id: "platform",
        expression: "import('cloudflare:workers').catch(error=>error.code)",
      })
    ).json(),
  );
  expect(platform.output?.result).toBe("MODULE_NOT_FOUND");
});

test("dynamic imports use import meta without capturing a shadowed global and support file URLs", async () => {
  const token = await setup("lazy-meta");
  expect(
    (
      await act("lazy-meta", token, {
        op: "filesystem.writeFile",
        path: "/tmp/a odd.mjs",
        content: "export const value=42; export const location=import.meta.url;",
        encoding: "utf8",
      })
    ).status,
  ).toBe(200);
  const executed = Schema.decodeUnknownSync(RunRecord)(
    await (
      await act("lazy-meta", token, {
        op: "javascript.execute",
        id: "meta",
        source:
          "const globalThis=0; const file='file:///tmp/a%20odd.mjs'; const loaded=await import(file); console.log(loaded.value,loaded.location);",
      })
    ).json(),
  );
  expect(executed.output?.stdout).toBe("42 file:///tmp/a%20odd.mjs\n");
});

test("an interrupted guest retains the sources it imported and its committed file writes", async () => {
  const token = await setup("lazy-interrupted");
  const executed = Schema.decodeUnknownSync(RunRecord)(
    await (
      await act("lazy-interrupted", token, {
        op: "javascript.execute",
        id: "loop",
        source:
          "await tools.call({op:'filesystem.writeFile',path:'/tmp/loaded.mjs',content:'export const answer=42;',encoding:'utf8'}); const path='/tmp/loaded.mjs'; await import(path); while(true) {}",
      })
    ).json(),
  );
  expect(executed.status).toBe("failed");
  expect(
    (await act("lazy-interrupted", token, { op: "filesystem.readFile", path: "/tmp/loaded.mjs" }))
      .status,
  ).toBe(200);
  const bucket = await mf.getR2Bucket("OBJECTS");
  const source = await bucket.get(`sandboxes/lazy-interrupted/code/${executed.sourceHash}`);
  if (source === null) return expect(source).not.toBeNull();
  const graph = Schema.decodeUnknownSync(Schema.fromJsonString(ScriptProgram))(await source.text());
  expect(graph.modules.some((module) => module.name === "/tmp/loaded.mjs")).toBe(true);
});

test("guest cannot access network or host bindings", async () => {
  const token = await setup("escape");
  const result = await act("escape", token, {
    op: "process.run",
    id: "escape-1",
    language: "javascript",
    source: `export default () => ({ process: typeof process, fetch: typeof fetch, env: typeof env, loader: typeof LOADER });`,
  });
  const record = Schema.decodeUnknownSync(RunRecord)(await result.json());
  expect(record.status).toBe("exited");
  expect(record.output?.result).toEqual({
    process: "undefined",
    fetch: "undefined",
    env: "undefined",
    loader: "undefined",
  });
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

test("native Python executes, captures output and resumes multiple authorized R2 tool requests", async () => {
  const token = await setup("python");
  const response = await act("python", token, {
    op: "process.run",
    id: "python-1",
    language: "python",
    source:
      "print('native Python')\nawait tools.call({'op':'filesystem.writeFile','path':'/tmp/python','content':'from Python','encoding':'utf8'})\ndata = await tools.call({'op':'filesystem.readFile','path':'/tmp/python'})\n{'answer': 6 * 7, 'content': data['content']}",
  });
  expect(response.status).toBe(200);
  const record = Schema.decodeUnknownSync(RunRecord)(await response.json());
  expect(record.status).toBe("exited");
  expect(record.output?.exitCode).toBe(0);
  expect(record.output?.stdout).toBe("native Python\n");
  expect(record.output?.result).toEqual({
    answer: 42,
    content: Buffer.from("from Python").toString("base64"),
  });
  const persisted = Schema.decodeUnknownSync(FileContent)(
    await (await act("python", token, { op: "filesystem.readFile", path: "/tmp/python" })).json(),
  );
  expect(Buffer.from(persisted.content, "base64").toString()).toBe("from Python");
});

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

test("TypeScript compiles in Rust and persists through scoped capabilities", async () => {
  const token = await setup("typescript-files");
  const result = await act("typescript-files", token, {
    op: "process.run",
    id: "write-1",
    language: "typescript",
    source:
      "interface Value { answer: number } enum Choice { First, Second } export default async ({tools}: { tools: { call(action: unknown): Promise<unknown> } }): Promise<Value> => { await tools.call({op:'filesystem.writeFile',path:'/tmp/ts',content:'typescript persisted',encoding:'utf8'}); return {answer:41+Choice.Second}; }",
  });
  const record = Schema.decodeUnknownSync(RunRecord)(await result.json());
  expect(record.status).toBe("exited");
  expect(record.output?.result).toEqual({ answer: 42 });
  const file = Schema.decodeUnknownSync(FileContent)(
    await (
      await act("typescript-files", token, { op: "filesystem.readFile", path: "/tmp/ts" })
    ).json(),
  );
  expect(Buffer.from(file.content, "base64").toString()).toBe("typescript persisted");
});

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
  expect(
    (await act("config", token, { op: "config.patch", policy: { interruptBudget: 2000 } })).status,
  ).toBe(200);
  const status = Schema.decodeUnknownSync(Status)(
    await (await act("config", token, { op: "vm.status" })).json(),
  );
  expect(status.policy.interruptBudget).toBe(2000);
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
  expect(
    (await act("config", token, { op: "config.patch", policy: { interruptBudget: 0 } })).status,
  ).toBe(400);
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

test("native R2 migration preserves files and tombstones and is idempotent", async () => {
  const token = await setup("migration");
  expect(
    (
      await act("migration", token, {
        op: "filesystem.writeFile",
        path: "/tmp/kept",
        content: "preserved",
        encoding: "utf8",
      })
    ).status,
  ).toBe(200);
  const bucket = await mf.getR2Bucket("OBJECTS");
  const key = "sandboxes/migration/head.json";
  const object = await bucket.get(key);
  if (object === null) return expect(object).not.toBeNull();
  const head = Schema.decodeUnknownSync(Schema.fromJsonString(Head))(await object.text());
  const prior = {
    manifest: head.manifest,
    createdAt: head.createdAt,
    deleted: head.deleted,
    policy: {
      networkHosts: head.policy.networkHosts,
      cpuMs: 1000,
      maxOutputBytes: head.policy.maxOutputBytes,
    },
  };
  await bucket.put(key, JSON.stringify(prior));
  await bucket.put(
    "sandboxes/migration-deleted/head.json",
    JSON.stringify({ ...prior, deleted: true }),
  );
  expect((await post("/v1/migrations/execution-policy-v2", token, {})).status).toBe(401);
  const first = Schema.decodeUnknownSync(MigrationReceipt)(
    await (await post("/v1/migrations/execution-policy-v2", admin, {})).json(),
  );
  expect(first.migrated).toBe(2);
  const file = Schema.decodeUnknownSync(FileContent)(
    await (await act("migration", token, { op: "filesystem.readFile", path: "/tmp/kept" })).json(),
  );
  expect(Buffer.from(file.content, "base64").toString()).toBe("preserved");
  const tombstone = await bucket.get("sandboxes/migration-deleted/head.json");
  if (tombstone === null) return expect(tombstone).not.toBeNull();
  expect(
    Schema.decodeUnknownSync(Schema.fromJsonString(Head))(await tombstone.text()).deleted,
  ).toBe(true);
  const second = Schema.decodeUnknownSync(MigrationReceipt)(
    await (await post("/v1/migrations/execution-policy-v2", admin, {})).json(),
  );
  expect(second.migrated).toBe(0);
});

test("batch writes publish once, retain ordered successes and report per-file failures", async () => {
  const token = await setup("batch");
  const before = Schema.decodeUnknownSync(Status)(
    await (await act("batch", token, { op: "vm.status" })).json(),
  );
  const response = await act("batch", token, {
    op: "filesystem.writeFiles",
    entries: [
      { path: "/tmp/nested/a", content: "first", encoding: "utf8" },
      { path: "/tmp/nested/a", content: "%%%", encoding: "base64" },
      { path: "/tmp/nested/a", content: "last", encoding: "utf8" },
      { path: "/tmp/nested/a/child", content: "blocked", encoding: "utf8" },
      { path: "/tmp/binary", content: "AP8=", encoding: "base64" },
    ],
  });
  expect(response.status).toBe(200);
  const writes = Schema.decodeUnknownSync(BatchWriteResults)(await response.json());
  expect(writes.map((item) => item.success)).toEqual([true, false, true, false, true]);
  const after = Schema.decodeUnknownSync(Status)(
    await (await act("batch", token, { op: "vm.status" })).json(),
  );
  expect(after.generation).toBe(before.generation + 1);
  const reads = Schema.decodeUnknownSync(BatchReadResults)(
    await (
      await act("batch", token, {
        op: "filesystem.readFiles",
        paths: ["/tmp/nested/a", "/tmp/missing", "/tmp/binary", "/tmp"],
      })
    ).json(),
  );
  expect(reads.map((item) => item.content)).toEqual([
    Buffer.from("last").toString("base64"),
    null,
    "AP8=",
    null,
  ]);
  expect((await act("batch", token, { op: "filesystem.writeFiles", entries: [] })).status).toBe(
    200,
  );
  const empty = Schema.decodeUnknownSync(Status)(
    await (await act("batch", token, { op: "vm.status" })).json(),
  );
  expect(empty.generation).toBe(after.generation);
});

test("recursive listing honors depth, exclusion, root aliases and non-recursive symlinks", async () => {
  const token = await setup("tree");
  expect(
    (
      await act("tree", token, {
        op: "filesystem.writeFiles",
        entries: [
          { path: "/tmp/tree/deep/a", content: "a", encoding: "utf8" },
          { path: "/tmp/tree/excluded/b", content: "b", encoding: "utf8" },
          { path: "/tmp/tree/z", content: "z", encoding: "utf8" },
        ],
      })
    ).status,
  ).toBe(200);
  expect(
    (await act("tree", token, { op: "filesystem.symlink", path: "/tmp/alias", target: "tree" }))
      .status,
  ).toBe(200);
  expect(
    (await act("tree", token, { op: "filesystem.symlink", path: "/tmp/tree/link", target: "deep" }))
      .status,
  ).toBe(200);
  const tree = Schema.decodeUnknownSync(DirectoryTree)(
    await (
      await act("tree", token, {
        op: "filesystem.readdirRecursive",
        path: "/tmp/alias",
        exclude: ["excluded"],
      })
    ).json(),
  );
  expect(tree.map((entry) => entry.path)).toEqual([
    "/tmp/alias/deep",
    "/tmp/alias/deep/a",
    "/tmp/alias/link",
    "/tmp/alias/z",
  ]);
  const shallow = Schema.decodeUnknownSync(DirectoryTree)(
    await (
      await act("tree", token, {
        op: "filesystem.readdirRecursive",
        path: "/tmp/tree",
        maxDepth: 0,
      })
    ).json(),
  );
  expect(shallow.map((entry) => entry.path)).toEqual([
    "/tmp/tree/deep",
    "/tmp/tree/excluded",
    "/tmp/tree/link",
    "/tmp/tree/z",
  ]);
  const path = Schema.decodeUnknownSync(CanonicalPath)(
    await (
      await act("tree", token, { op: "filesystem.realpath", path: "/tmp/alias/link/a" })
    ).json(),
  );
  expect(path.path).toBe("/tmp/tree/deep/a");
  expect(
    (await act("tree", token, { op: "filesystem.chmod", path: "/tmp/tree/deep", mode: 0 })).status,
  ).toBe(200);
  expect(
    (await act("tree", token, { op: "filesystem.readdirRecursive", path: "/tmp/tree" })).status,
  ).toBe(403);
  expect(
    (
      await act("tree", token, {
        op: "filesystem.readdirRecursive",
        path: "/tmp/tree",
        exclude: ["deep"],
      })
    ).status,
  ).toBe(200);
});

test("batch contracts enforce grants and bounds before mutation", async () => {
  const token = await setup("batch-permissions", ["write"]);
  expect(
    (await act("batch-permissions", token, { op: "filesystem.readFiles", paths: [] })).status,
  ).toBe(403);
  expect(
    (await act("batch-permissions", token, { op: "filesystem.realpath", path: "/" })).status,
  ).toBe(403);
  expect(
    (
      await act("batch-permissions", token, {
        op: "filesystem.writeFiles",
        entries: [],
        ignored: true,
      })
    ).status,
  ).toBe(400);
  expect(
    (
      await act("batch-permissions", token, {
        op: "filesystem.writeFiles",
        entries: Array.from({ length: 129 }, () => ({
          path: "/tmp/a",
          content: "x",
          encoding: "utf8",
        })),
      })
    ).status,
  ).toBe(400);
});

test("guest batch tools preserve response contracts and concurrent roots cannot mix files", async () => {
  const token = await setup("batch-race");
  const run = Schema.decodeUnknownSync(RunRecord)(
    await (
      await act("batch-race", token, {
        op: "javascript.evaluate",
        id: "guest-batch",
        expression:
          "(async () => { const writes=await tools.call({op:'filesystem.writeFiles',entries:[{path:'/tmp/guest/a',content:'guest',encoding:'utf8'}]}); const reads=await tools.call({op:'filesystem.readFiles',paths:['/tmp/guest/a','/missing']}); const tree=await tools.call({op:'filesystem.readdirRecursive',path:'/tmp/guest'}); return [writes[0].success,reads[0].content,reads[1].code,tree[0].path]; })()",
      })
    ).json(),
  );
  expect(run.output?.result).toEqual([
    true,
    Buffer.from("guest").toString("base64"),
    "ENOENT",
    "/tmp/guest/a",
  ]);
  const results = await Promise.all(
    ["first", "second"].map((content) =>
      act("batch-race", token, {
        op: "filesystem.writeFiles",
        entries: ["a", "b"].map((name) => ({
          path: `/tmp/race/${name}`,
          content,
          encoding: "utf8",
        })),
      }),
    ),
  );
  expect(results.every((response) => [200, 409].includes(response.status))).toBe(true);
  expect(results.some((response) => response.status === 200)).toBe(true);
  const final = Schema.decodeUnknownSync(BatchReadResults)(
    await (
      await act("batch-race", token, {
        op: "filesystem.readFiles",
        paths: ["/tmp/race/a", "/tmp/race/b"],
      })
    ).json(),
  );
  expect(final[0]?.content).toBe(final[1]?.content);
});

test("aggregate read and write batch quotas reject without a new generation", async () => {
  const token = await setup("batch-quota");
  expect(
    (
      await act("batch-quota", token, {
        op: "filesystem.writeFile",
        path: "/tmp/large",
        content: "x".repeat(8_388_609),
        encoding: "utf8",
      })
    ).status,
  ).toBe(200);
  const before = Schema.decodeUnknownSync(Status)(
    await (await act("batch-quota", token, { op: "vm.status" })).json(),
  );
  expect(
    (
      await act("batch-quota", token, {
        op: "filesystem.readFiles",
        paths: ["/tmp/large", "/tmp/large"],
      })
    ).status,
  ).toBe(413);
  expect(
    (
      await act("batch-quota", token, {
        op: "filesystem.writeFiles",
        entries: ["a", "b"].map((name) => ({
          path: `/tmp/${name}`,
          content: "x".repeat(8_388_609),
          encoding: "utf8",
        })),
      })
    ).status,
  ).toBe(413);
  const after = Schema.decodeUnknownSync(Status)(
    await (await act("batch-quota", token, { op: "vm.status" })).json(),
  );
  expect(after.generation).toBe(before.generation);
});

const wasmFixture = async (name: string) =>
  Buffer.from(
    await Bun.file(join(import.meta.dir, `../dist/wasi-${name}.wasm`)).arrayBuffer(),
  ).toString("base64");

test("WASI ABI rejects invalid pointers, directory escape and closed stdio and bounds descriptors", async () => {
  const token = await setup("wasi-abi");
  expect(
    (
      await act("wasi-abi", token, {
        op: "filesystem.writeFile",
        path: "/tmp/existing",
        content: "original",
        encoding: "utf8",
      })
    ).status,
  ).toBe(200);
  for (const [name, expected] of [
    ["bad-pointer", 21],
    ["escape", 76],
    ["closed-stdio", 8],
    ["descriptors", 33],
  ] as const) {
    const record = Schema.decodeUnknownSync(RunRecord)(
      await (
        await act("wasi-abi", token, {
          op: "process.run",
          id: name,
          language: "wasm",
          source: await wasmFixture(name),
        })
      ).json(),
    );
    expect(record.status).toBe("exited");
    expect(record.output?.result).toBe(expected);
  }
});

test("WASI descriptor rights and write-only capabilities cannot expose preserved file bytes", async () => {
  const token = await setup("wasi-rights");
  expect(
    (
      await act("wasi-rights", token, {
        op: "filesystem.writeFile",
        path: "/tmp/existing",
        content: "original",
        encoding: "utf8",
      })
    ).status,
  ).toBe(200);
  const readonly = Schema.decodeUnknownSync(RunRecord)(
    await (
      await act("wasi-rights", token, {
        op: "process.run",
        id: "rights",
        language: "wasm",
        source: await wasmFixture("rights"),
      })
    ).json(),
  );
  expect(readonly.output?.result).toBe(76);
  const writeonly = Schema.decodeUnknownSync(TokenResponse)(
    await (
      await post("/v1/sandboxes/wasi-rights/capabilities", admin, {
        permissions: ["write", "execute"],
        expiresInSeconds: 3600,
      })
    ).json(),
  ).token;
  expect(
    (
      await act("wasi-rights", token, {
        op: "filesystem.chmod",
        path: "/tmp/existing",
        mode: 0o200,
      })
    ).status,
  ).toBe(200);
  const denied = Schema.decodeUnknownSync(RunRecord)(
    await (
      await act("wasi-rights", writeonly, {
        op: "process.run",
        id: "writeonly",
        language: "wasm",
        source: await wasmFixture("writeonly"),
      })
    ).json(),
  );
  expect(denied.output?.result).toBe(76);
  const written = Schema.decodeUnknownSync(RunRecord)(
    await (
      await act("wasi-rights", writeonly, {
        op: "process.run",
        id: "write",
        language: "wasm",
        source: await wasmFixture("writeonly-write"),
      })
    ).json(),
  );
  expect(written.output?.result).toBe(0);
  expect(
    (await act("wasi-rights", writeonly, { op: "filesystem.readFile", path: "/tmp/existing" }))
      .status,
  ).toBe(403);
  expect(
    (
      await act("wasi-rights", token, {
        op: "filesystem.chmod",
        path: "/tmp/existing",
        mode: 0o600,
      })
    ).status,
  ).toBe(200);
  const file = Schema.decodeUnknownSync(FileContent)(
    await (
      await act("wasi-rights", token, { op: "filesystem.readFile", path: "/tmp/existing" })
    ).json(),
  );
  expect(Buffer.from(file.content, "base64").toString()).toBe("changedl");
});

test("WASI symlinks respect no-follow and directory descriptor confinement", async () => {
  const token = await setup("wasi-symlinks");
  expect(
    (
      await act("wasi-symlinks", token, {
        op: "filesystem.writeFiles",
        entries: [
          { path: "/home/cirro/private", content: "secret", encoding: "utf8" },
          { path: "/tmp/scoped/inside", content: "inside", encoding: "utf8" },
        ],
      })
    ).status,
  ).toBe(200);
  expect(
    (
      await act("wasi-symlinks", token, {
        op: "filesystem.symlink",
        path: "/tmp/link",
        target: "/home/cirro/private",
      })
    ).status,
  ).toBe(200);
  expect(
    (
      await act("wasi-symlinks", token, {
        op: "filesystem.symlink",
        path: "/tmp/scoped/outside",
        target: "/home/cirro/private",
      })
    ).status,
  ).toBe(200);
  for (const [name, expected] of [
    ["nofollow", 32],
    ["symlink-escape", 76],
    ["setter-escape", 76],
  ] as const) {
    const record = Schema.decodeUnknownSync(RunRecord)(
      await (
        await act("wasi-symlinks", token, {
          op: "process.run",
          id: name,
          language: "wasm",
          source: await wasmFixture(name),
        })
      ).json(),
    );
    expect(record.output?.result).toBe(expected);
    expect(record.output?.stdout).toBe("");
  }
});

test("WASI creation requires write permission while clocks and entropy need only execution", async () => {
  const token = await setup("wasi-grants", ["execute"]);
  const denied = Schema.decodeUnknownSync(RunRecord)(
    await (
      await act("wasi-grants", token, {
        op: "process.run",
        id: "denied",
        language: "wasm",
        source: await wasmFixture("create-denied"),
      })
    ).json(),
  );
  expect(denied.output?.result).toBe(2);
  const random = Schema.decodeUnknownSync(RunRecord)(
    await (
      await act("wasi-grants", token, {
        op: "process.run",
        id: "random",
        language: "wasm",
        source: await wasmFixture("clock-random"),
      })
    ).json(),
  );
  expect(random.output?.result).toBe(42);
  const exit = Schema.decodeUnknownSync(RunRecord)(
    await (
      await act("wasi-grants", token, {
        op: "process.run",
        id: "exit",
        language: "wasm",
        source: await wasmFixture("exit"),
      })
    ).json(),
  );
  expect(exit.output?.exitCode).toBe(7);
  expect(exit.output?.result).toBeNull();
});

test("WASI traps discard uncommitted changes while explicit sync preserves its checkpoint", async () => {
  const token = await setup("wasi-checkpoint");
  const trap = Schema.decodeUnknownSync(RunRecord)(
    await (
      await act("wasi-checkpoint", token, {
        op: "process.run",
        id: "trap",
        language: "wasm",
        source: await wasmFixture("trap"),
      })
    ).json(),
  );
  expect(trap.status).toBe("failed");
  expect(
    (await act("wasi-checkpoint", token, { op: "filesystem.readFile", path: "/tmp/from-abi" }))
      .status,
  ).toBe(404);
  const synced = Schema.decodeUnknownSync(RunRecord)(
    await (
      await act("wasi-checkpoint", token, {
        op: "process.run",
        id: "synced",
        language: "wasm",
        source: await wasmFixture("synced-trap"),
      })
    ).json(),
  );
  expect(synced.status).toBe("failed");
  const file = Schema.decodeUnknownSync(FileContent)(
    await (
      await act("wasi-checkpoint", token, { op: "filesystem.readFile", path: "/tmp/from-abi" })
    ).json(),
  );
  expect(Buffer.from(file.content, "base64").toString()).toBe("before trap");
});

test("WASI fuel, memory and serialized output limits cannot poison the Worker", async () => {
  const token = await setup("wasi-limits");
  for (const name of ["fuel", "memory", "output", "budget"]) {
    const record = Schema.decodeUnknownSync(RunRecord)(
      await (
        await act("wasi-limits", token, {
          op: "process.run",
          id: name,
          language: "wasm",
          source: await wasmFixture(name),
        })
      ).json(),
    );
    expect(record.status).toBe("failed");
    expect(record.output).toBeNull();
    expect((await act("wasi-limits", token, { op: "vm.status" })).status).toBe(200);
  }
});

test("WASI positional I/O preserves offsets and simultaneous descriptors share file contents", async () => {
  const token = await setup("wasi-offsets");
  for (const name of ["positioned", "aliases"]) {
    expect(
      (
        await act("wasi-offsets", token, {
          op: "filesystem.writeFile",
          path: "/tmp/existing",
          content: "original",
          encoding: "utf8",
        })
      ).status,
    ).toBe(200);
    const record = Schema.decodeUnknownSync(RunRecord)(
      await (
        await act("wasi-offsets", token, {
          op: "process.run",
          id: name,
          language: "wasm",
          source: await wasmFixture(name),
        })
      ).json(),
    );
    expect(record.output?.result).toBe(42);
  }
});

test("WASI writes surface real filesystem quota failures before reporting success", async () => {
  const token = await setup("wasi-quota");
  for (const index of [0, 1, 2, 3])
    expect(
      (
        await act("wasi-quota", token, {
          op: "filesystem.writeFile",
          path: `/tmp/full-${index}`,
          content: "x".repeat(16_777_216),
          encoding: "utf8",
        })
      ).status,
    ).toBe(200);
  const record = Schema.decodeUnknownSync(RunRecord)(
    await (
      await act("wasi-quota", token, {
        op: "process.run",
        id: "quota",
        language: "wasm",
        source: await wasmFixture("create-denied"),
      })
    ).json(),
  );
  expect(record.output?.result).toBe(51);
  const file = Schema.decodeUnknownSync(FileContent)(
    await (
      await act("wasi-quota", token, { op: "filesystem.readFile", path: "/tmp/from-abi" })
    ).json(),
  );
  expect(file.size).toBe(0);
});

test("WASI open buffers reject allocation beyond 16 MiB and closing the last descriptor frees capacity", async () => {
  const token = await setup("wasi-buffers");
  expect(
    (
      await act("wasi-buffers", token, {
        op: "filesystem.writeFile",
        path: "/tmp/large",
        content: "x".repeat(16_777_216),
        encoding: "utf8",
      })
    ).status,
  ).toBe(200);
  expect(
    (
      await act("wasi-buffers", token, {
        op: "filesystem.writeFile",
        path: "/tmp/small",
        content: "y",
        encoding: "utf8",
      })
    ).status,
  ).toBe(200);
  const record = Schema.decodeUnknownSync(RunRecord)(
    await (
      await act("wasi-buffers", token, {
        op: "process.run",
        id: "buffers",
        language: "wasm",
        source: await wasmFixture("buffers"),
      })
    ).json(),
  );
  expect(record.output?.result).toBe(42);
  expect((await act("wasi-buffers", token, { op: "vm.status" })).status).toBe(200);
});

test("concurrent WASI executions publish complete file sets and never combine different roots", async () => {
  const token = await setup("wasi-race");
  const sources = await Promise.all(["race-a", "race-b"].map((name) => wasmFixture(name)));
  const receipts = await Promise.all(
    sources.map(async (source, index) =>
      Schema.decodeUnknownSync(RunRecord)(
        await (
          await act("wasi-race", token, {
            op: "process.run",
            id: `race-${index}`,
            language: "wasm",
            source,
          })
        ).json(),
      ),
    ),
  );
  expect(
    receipts.some((record) => record.status === "exited" && record.output?.result === 42),
  ).toBe(true);
  const files = Schema.decodeUnknownSync(BatchReadResults)(
    await (
      await act("wasi-race", token, {
        op: "filesystem.readFiles",
        paths: ["/tmp/race-one", "/tmp/race-two"],
      })
    ).json(),
  );
  expect(files[0]?.content).toBe(files[1]?.content);
  expect(["QQ==", "Qg=="].includes(files[0]?.content ?? "")).toBe(true);
});

test("WASI argv, isolated environment and binary stdin persist as a complete code artifact", async () => {
  const token = await setup("wasi-inputs");
  const source = Buffer.from(
    await Bun.file(join(import.meta.dir, "../dist/wasi-inputs.wasm")).arrayBuffer(),
  ).toString("base64");
  const env = JSON.parse('{"CIRRO_MARKER":"ação","__proto__":"safe"}');
  const response = await act("wasi-inputs", token, {
    op: "process.run",
    id: "inputs",
    language: "wasm",
    source,
    args: ["ação", "two words"],
    env,
    stdin: { content: "AP8K", encoding: "base64" },
  });
  expect(response.status).toBe(200);
  const run = Schema.decodeUnknownSync(RunRecord)(await response.json());
  expect(run.output?.exitCode).toBe(0);
  expect(run.output?.stdout).toBe(
    'argv=["/tmp/__cirro_inline__.wasm", "ação", "two words"]\nmarker=ação\nprivate=unset\nproto=safe\nstdin=[0, 255, 10]\neof=0\n',
  );
  const bucket = await mf.getR2Bucket("OBJECTS");
  const object = await bucket.get(`sandboxes/wasi-inputs/code/${run.sourceHash}`);
  if (object === null) return expect(object).not.toBeNull();
  const program = Schema.decodeUnknownSync(Schema.fromJsonString(WasmProgram))(await object.text());
  expect(program.argv).toEqual(["/tmp/__cirro_inline__.wasm", "ação", "two words"]);
  expect(program.env.CIRRO_MARKER).toBe("ação");
  expect(program.env.__proto__).toBe("safe");
  expect(program.stdin).toBe("AP8K");
});

test("WASI executeFile requires read and captures binary bytes before subsequent file changes", async () => {
  const token = await setup("wasi-file-inputs");
  const source = Buffer.from(
    await Bun.file(join(import.meta.dir, "../dist/wasi-inputs.wasm")).arrayBuffer(),
  ).toString("base64");
  expect(
    (
      await act("wasi-file-inputs", token, {
        op: "filesystem.writeFile",
        path: "/tmp/cli.wasm",
        content: source,
        encoding: "base64",
      })
    ).status,
  ).toBe(200);
  const executeOnly = Schema.decodeUnknownSync(TokenResponse)(
    await (
      await post("/v1/sandboxes/wasi-file-inputs/capabilities", admin, {
        permissions: ["execute"],
        expiresInSeconds: 3600,
      })
    ).json(),
  ).token;
  expect(
    (
      await act("wasi-file-inputs", executeOnly, {
        op: "wasm.executeFile",
        id: "file",
        path: "/tmp/cli.wasm",
      })
    ).status,
  ).toBe(403);
  const run = Schema.decodeUnknownSync(RunRecord)(
    await (
      await act("wasi-file-inputs", token, {
        op: "wasm.executeFile",
        id: "file",
        path: "/tmp/cli.wasm",
        args: ["file"],
        stdin: { content: "fala", encoding: "utf8" },
      })
    ).json(),
  );
  expect(run.output?.stdout).toContain('argv=["/tmp/cli.wasm", "file"]');
  expect(run.output?.stdout).toContain("stdin=[102, 97, 108, 97]");
  expect(
    (
      await act("wasi-file-inputs", token, {
        op: "filesystem.writeFile",
        path: "/tmp/cli.wasm",
        content: "changed",
        encoding: "utf8",
      })
    ).status,
  ).toBe(200);
  const bucket = await mf.getR2Bucket("OBJECTS");
  const object = await bucket.get(`sandboxes/wasi-file-inputs/code/${run.sourceHash}`);
  if (object === null) return expect(object).not.toBeNull();
  const archived = Schema.decodeUnknownSync(Schema.fromJsonString(WasmProgram))(
    await object.text(),
  );
  expect(archived.source).toBe(source);
});

test("WASI malformed inputs reject before reserving a run and cannot enter other language contracts", async () => {
  const token = await setup("wasi-bad-inputs");
  const source = await wasmFixture("exit");
  for (const input of [
    { args: ["bad\0value"] },
    { args: Array.from({ length: 17 }, () => "x".repeat(4096)) },
    { env: { "BAD=KEY": "value" } },
    { args: ["é".repeat(4096)] },
    { args: ["\ud800"] },
    { stdin: { content: "AB==", encoding: "base64" } },
    { stdin: { content: "x".repeat(1_048_577), encoding: "utf8" } },
  ]) {
    const response = await act("wasi-bad-inputs", token, {
      op: "process.run",
      id: "bad",
      language: "wasm",
      source,
      ...input,
    });
    expect([400, 413].includes(response.status)).toBe(true);
    expect((await act("wasi-bad-inputs", token, { op: "process.get", id: "bad" })).status).toBe(
      404,
    );
  }
  expect(
    (
      await act("wasi-bad-inputs", token, {
        op: "process.run",
        id: "js",
        language: "javascript",
        source: "export default()=>42",
        args: ["ignored"],
      })
    ).status,
  ).toBe(400);
  const valid = Schema.decodeUnknownSync(RunRecord)(
    await (
      await act("wasi-bad-inputs", token, {
        op: "process.run",
        id: "bad",
        language: "wasm",
        source,
      })
    ).json(),
  );
  expect(valid.output?.exitCode).toBe(7);
});

test("Wasm input migration preserves old results and updates source references and native listing metadata", async () => {
  const token = await setup("wasm-input-migration");
  const source = Buffer.from(
    await Bun.file(join(import.meta.dir, "../dist/guest-test.wasm")).arrayBuffer(),
  );
  const run = Schema.decodeUnknownSync(RunRecord)(
    await (
      await act("wasm-input-migration", token, {
        op: "process.run",
        id: "prior",
        language: "wasm",
        source: source.toString("base64"),
      })
    ).json(),
  );
  const bucket = await mf.getR2Bucket("OBJECTS");
  const oldHash = Buffer.from(await crypto.subtle.digest("SHA-256", source)).toString("hex");
  await bucket.put(`sandboxes/wasm-input-migration/code/${oldHash}`, source);
  const prior = { ...run, sourceHash: oldHash };
  await bucket.put(
    "sandboxes/wasm-input-migration/runs/prior.json",
    Schema.encodeSync(Schema.fromJsonString(RunRecord))(prior),
    { customMetadata: Schema.encodeSync(RunMetadata)({ summary: Struct.omit(prior, ["output"]) }) },
  );
  await bucket.put(
    "sandboxes/wasm-input-migration/runs/no-metadata.json",
    Schema.encodeSync(Schema.fromJsonString(RunRecord))({ ...prior, id: "no-metadata" }),
  );
  expect((await post("/v1/migrations/wasm-inputs-v1", token, {})).status).toBe(401);
  const receipt = Schema.decodeUnknownSync(MigrationReceipt)(
    await (await post("/v1/migrations/wasm-inputs-v1", admin, {})).json(),
  );
  expect(receipt.migrated).toBe(2);
  const converted = Schema.decodeUnknownSync(RunRecord)(
    await (await act("wasm-input-migration", token, { op: "process.get", id: "prior" })).json(),
  );
  expect(converted.sourceHash).not.toBe(oldHash);
  expect(converted.output).toEqual(run.output);
  expect(converted.startedAt).toBe(run.startedAt);
  const artifact = await bucket.get(`sandboxes/wasm-input-migration/code/${converted.sourceHash}`);
  if (artifact === null) return expect(artifact).not.toBeNull();
  const program = Schema.decodeUnknownSync(Schema.fromJsonString(WasmProgram))(
    await artifact.text(),
  );
  expect(program.argv).toEqual([]);
  expect(program.env).toEqual({});
  expect(program.stdin).toBe("");
  expect(program.source).toBe(source.toString("base64"));
  const page = Schema.decodeUnknownSync(ProcessPage)(
    await (
      await act("wasm-input-migration", token, { op: "process.list", limit: 10, cursor: null })
    ).json(),
  );
  expect(page.items.every((item) => item.sourceHash === converted.sourceHash)).toBe(true);
  const repeated = Schema.decodeUnknownSync(MigrationReceipt)(
    await (await post("/v1/migrations/wasm-inputs-v1", admin, {})).json(),
  );
  expect(repeated.migrated).toBe(0);
});

test("Wasm input migration rejects corrupt immutable source instead of rewriting a receipt", async () => {
  const token = await setup("wasm-corrupt-migration");
  const source = Buffer.from(
    await Bun.file(join(import.meta.dir, "../dist/guest-test.wasm")).arrayBuffer(),
  );
  const run = Schema.decodeUnknownSync(RunRecord)(
    await (
      await act("wasm-corrupt-migration", token, {
        op: "process.run",
        id: "prior",
        language: "wasm",
        source: source.toString("base64"),
      })
    ).json(),
  );
  const hash = Buffer.from(await crypto.subtle.digest("SHA-256", source)).toString("hex");
  const bucket = await mf.getR2Bucket("OBJECTS");
  await bucket.put(`sandboxes/wasm-corrupt-migration/code/${hash}`, "corrupt");
  await bucket.put(
    "sandboxes/wasm-corrupt-migration/runs/prior.json",
    Schema.encodeSync(Schema.fromJsonString(RunRecord))({ ...run, sourceHash: hash }),
  );
  expect((await post("/v1/migrations/wasm-inputs-v1", admin, {})).status).toBe(500);
  const unchanged = Schema.decodeUnknownSync(RunRecord)(
    await (await act("wasm-corrupt-migration", token, { op: "process.get", id: "prior" })).json(),
  );
  expect(unchanged.sourceHash).toBe(hash);
  await bucket.put(`sandboxes/wasm-corrupt-migration/code/${hash}`, source);
  expect((await post("/v1/migrations/wasm-inputs-v1", admin, {})).status).toBe(200);
});

test("concurrent WASI options stay isolated and different inputs have different artifact digests", async () => {
  const token = await setup("wasi-input-isolation");
  const source = Buffer.from(
    await Bun.file(join(import.meta.dir, "../dist/wasi-inputs.wasm")).arrayBuffer(),
  ).toString("base64");
  const results = await Promise.all(
    ["first", "second"].map(async (marker) =>
      Schema.decodeUnknownSync(RunRecord)(
        await (
          await act("wasi-input-isolation", token, {
            op: "process.run",
            id: marker,
            language: "wasm",
            source,
            args: [marker],
            env: { CIRRO_MARKER: marker, API_KEY: "caller-value" },
            stdin: { content: marker, encoding: "utf8" },
          })
        ).json(),
      ),
    ),
  );
  expect(results[0]?.output?.stdout).toContain("marker=first");
  expect(results[1]?.output?.stdout).toContain("marker=second");
  expect(results[0]?.output?.stdout).toContain("private=caller-value");
  expect(results[0]?.sourceHash).not.toBe(results[1]?.sourceHash);
});

test("Rust WASI path mutations, directory listing and replaced or unlinked open files retain their semantics", async () => {
  const token = await setup("wasi-paths");
  const source = Buffer.from(
    await Bun.file(join(import.meta.dir, "../dist/wasi-paths.wasm")).arrayBuffer(),
  ).toString("base64");
  const response = await act("wasi-paths", token, {
    op: "process.run",
    id: "paths",
    language: "wasm",
    source,
  });
  expect(response.status).toBe(200);
  const run = Schema.decodeUnknownSync(RunRecord)(await response.json());
  expect(run.output?.exitCode).toBe(0);
  expect(run.output?.stdout).toBe(
    'link=source\nnames=["link", "source", "target"]\nold=target bytes\ncurrent=updatedbytes\nmissing=true\npaths removed\n',
  );
  expect(
    (await act("wasi-paths", token, { op: "filesystem.readFile", path: "/tmp/paths/target" }))
      .status,
  ).toBe(404);
  expect(
    (await act("wasi-paths", token, { op: "filesystem.readdir", path: "/tmp/paths" })).status,
  ).toBe(404);
});

test("filesystem inode identities survive writes and rename while replacements retain the source identity", async () => {
  const token = await setup("inode");
  expect(
    (
      await act("inode", token, {
        op: "filesystem.writeFile",
        path: "/tmp/a",
        content: "a",
        encoding: "utf8",
      })
    ).status,
  ).toBe(200);
  const first = Schema.decodeUnknownSync(FileStat)(
    await (
      await act("inode", token, { op: "filesystem.stat", path: "/tmp/a", follow: true })
    ).json(),
  );
  expect(first.inode).toBeGreaterThan(0);
  expect(BigInt(first.mtimeNs)).toBeGreaterThan(0n);
  expect(
    (
      await act("inode", token, {
        op: "filesystem.writeFile",
        path: "/tmp/b",
        content: "b",
        encoding: "utf8",
      })
    ).status,
  ).toBe(200);
  const other = Schema.decodeUnknownSync(FileStat)(
    await (
      await act("inode", token, { op: "filesystem.stat", path: "/tmp/b", follow: true })
    ).json(),
  );
  expect(other.inode).not.toBe(first.inode);
  expect(
    (
      await act("inode", token, {
        op: "filesystem.writeFile",
        path: "/tmp/a",
        content: "changed",
        encoding: "utf8",
      })
    ).status,
  ).toBe(200);
  expect(
    (await act("inode", token, { op: "filesystem.move", from: "/tmp/a", to: "/tmp/b" })).status,
  ).toBe(200);
  const moved = Schema.decodeUnknownSync(FileStat)(
    await (
      await act("inode", token, { op: "filesystem.stat", path: "/tmp/b", follow: true })
    ).json(),
  );
  expect(moved.inode).toBe(first.inode);
  expect(BigInt(moved.mtimeNs)).toBeGreaterThanOrEqual(BigInt(first.mtimeNs));
  expect(BigInt(moved.ctimeNs)).toBeGreaterThanOrEqual(BigInt(moved.mtimeNs));
  const listing = Schema.decodeUnknownSync(DirectoryEntries)(
    await (await act("inode", token, { op: "filesystem.readdir", path: "/tmp" })).json(),
  );
  expect(listing.find((entry) => entry.name === "b")?.inode).toBe(first.inode);
});

test("metadata migration assigns persistent unique identities without inventing historical timestamps", async () => {
  const token = await setup("metadata-migration");
  const bucket = await mf.getR2Bucket("OBJECTS");
  const key = "sandboxes/metadata-migration/head.json";
  const stored = await bucket.get(key);
  if (stored === null) return expect(stored).not.toBeNull();
  const head = Schema.decodeUnknownSync(Schema.fromJsonString(Head))(await stored.text());
  const prior = JSON.stringify({
    version: 1,
    generation: 7,
    nodes: {
      "/": { kind: "directory", mode: 0o755 },
      "/tmp": { kind: "directory", mode: 0o777 },
      "/tmp/kept": { kind: "file", mode: 0o644, size: 0, chunks: [] },
    },
  });
  await bucket.put(
    key,
    Schema.encodeSync(Schema.fromJsonString(Head))({ ...head, manifest: prior }),
  );
  expect((await act("metadata-migration", token, { op: "vm.status" })).status).toBe(500);
  expect((await post("/v1/migrations/filesystem-v3", token, {})).status).toBe(401);
  const receipt = Schema.decodeUnknownSync(MigrationReceipt)(
    await (await post("/v1/migrations/filesystem-v3", admin, {})).json(),
  );
  expect(receipt.migrated).toBe(1);
  const stat = Schema.decodeUnknownSync(FileStat)(
    await (
      await act("metadata-migration", token, {
        op: "filesystem.stat",
        path: "/tmp/kept",
        follow: true,
      })
    ).json(),
  );
  expect(stat.inode).toBeGreaterThan(0);
  expect(stat.mtimeNs).toBe("0");
  const status = Schema.decodeUnknownSync(Status)(
    await (await act("metadata-migration", token, { op: "vm.status" })).json(),
  );
  expect(status.generation).toBe(7);
  const repeat = Schema.decodeUnknownSync(MigrationReceipt)(
    await (await post("/v1/migrations/filesystem-v3", admin, {})).json(),
  );
  expect(repeat.migrated).toBe(0);
});

test("WASI directory buffers, cookies, descriptor rights and path type errors use the native ABI", async () => {
  const token = await setup("wasi-path-abi");
  expect(
    (
      await act("wasi-path-abi", token, {
        op: "filesystem.writeFiles",
        entries: [
          { path: "/tmp/raw-dir/a", content: "a", encoding: "utf8" },
          { path: "/tmp/raw-dir/b/inside", content: "b", encoding: "utf8" },
        ],
      })
    ).status,
  ).toBe(200);
  expect(
    (
      await act("wasi-path-abi", token, {
        op: "filesystem.symlink",
        path: "/tmp/raw-dir/c",
        target: "target",
      })
    ).status,
  ).toBe(200);
  for (const [name, result] of [
    ["directory-cookies", 28],
    ["directory-rights", 76],
    ["path-types", 54],
    ["readlink-small", 42],
  ] as const) {
    const record = Schema.decodeUnknownSync(RunRecord)(
      await (
        await act("wasi-path-abi", token, {
          op: "process.run",
          id: name,
          language: "wasm",
          source: await wasmFixture(name),
        })
      ).json(),
    );
    expect(record.output?.result).toBe(result);
  }
});

test("WASI path mutations require write while directory and link reads require read", async () => {
  const token = await setup("wasi-path-grants", ["read", "execute"]);
  const source = Buffer.from(
    await Bun.file(join(import.meta.dir, "../dist/wasi-paths.wasm")).arrayBuffer(),
  ).toString("base64");
  const record = Schema.decodeUnknownSync(RunRecord)(
    await (
      await act("wasi-path-grants", token, {
        op: "process.run",
        id: "denied",
        language: "wasm",
        source,
      })
    ).json(),
  );
  expect(record.output?.exitCode).toBe(1);
  expect(record.output?.stderr).toContain("PermissionDenied");
  expect(
    (await act("wasi-path-grants", token, { op: "filesystem.readdir", path: "/tmp/paths" })).status,
  ).toBe(404);
});

test("Rust filesystem setters preserve cursor, zero extension, precise timestamps and detached files", async () => {
  const token = await setup("wasi-setters");
  const response = await act("wasi-setters", token, {
    op: "process.run",
    id: "setters",
    language: "wasm",
    source: await wasmFixture("setters"),
  });
  expect(response.status).toBe(200);
  const record = Schema.decodeUnknownSync(RunRecord)(await response.json());
  expect(record.status).toBe("exited");
  expect(record.output?.exitCode).toBe(0);
  expect(record.output?.stdout).toBe(
    "setters preserved offsets, zeros, precise times and detached inodes\n",
  );
  const file = Schema.decodeUnknownSync(FileContent)(
    await (
      await act("wasi-setters", token, { op: "filesystem.readFile", path: "/tmp/setters" })
    ).json(),
  );
  expect(Buffer.from(file.content, "base64")).toEqual(Buffer.from([111, 114, 0, 0, 0, 0, 0, 0]));
  const stat = Schema.decodeUnknownSync(FileStat)(
    await (
      await act("wasi-setters", token, {
        op: "filesystem.stat",
        path: "/tmp/setters",
        follow: true,
      })
    ).json(),
  );
  expect(stat.atimeNs).toBe("18446744073709551615");
  expect(stat.mtimeNs).toBe("9007199254740995");
  const link = Schema.decodeUnknownSync(FileStat)(
    await (
      await act("wasi-setters", token, {
        op: "filesystem.stat",
        path: "/tmp/setters-link",
        follow: false,
      })
    ).json(),
  );
  expect(link.atimeNs).toBe("111");
  expect(link.mtimeNs).toBe("222");
  const directory = Schema.decodeUnknownSync(FileStat)(
    await (
      await act("wasi-setters", token, {
        op: "filesystem.stat",
        path: "/tmp/setters-dir",
        follow: true,
      })
    ).json(),
  );
  expect(directory.atimeNs).toBe("555");
  expect(directory.mtimeNs).toBe("666");
  expect(
    (
      await act("wasi-setters", token, {
        op: "filesystem.stat",
        path: "/tmp/setters-detached",
        follow: true,
      })
    ).status,
  ).toBe(404);
});

test("WASI setters enforce descriptor rights, validate flags and use one trusted timestamp for NOW", async () => {
  const token = await setup("wasi-setter-abi");
  expect(
    (
      await act("wasi-setter-abi", token, {
        op: "filesystem.writeFile",
        path: "/tmp/existing",
        content: "original",
        encoding: "utf8",
      })
    ).status,
  ).toBe(200);
  const before = Schema.decodeUnknownSync(FileStat)(
    await (
      await act("wasi-setter-abi", token, {
        op: "filesystem.stat",
        path: "/tmp/existing",
        follow: true,
      })
    ).json(),
  );
  for (const name of ["setter-rights", "setter-flags", "setter-now"]) {
    const record = Schema.decodeUnknownSync(RunRecord)(
      await (
        await act("wasi-setter-abi", token, {
          op: "process.run",
          id: name,
          language: "wasm",
          source: await wasmFixture(name),
        })
      ).json(),
    );
    expect(record.output?.result).toBe(42);
  }
  const after = Schema.decodeUnknownSync(FileStat)(
    await (
      await act("wasi-setter-abi", token, {
        op: "filesystem.stat",
        path: "/tmp/existing",
        follow: true,
      })
    ).json(),
  );
  expect(after.atimeNs).toBe(after.mtimeNs);
  expect(after.mtimeNs).toBe(after.ctimeNs);
  expect(BigInt(after.atimeNs)).toBeGreaterThan(BigInt(before.atimeNs));
  expect(after.inode).toBe(before.inode);
});

test("denied WASI setters roll back both shrinking and growing file buffers without publishing metadata", async () => {
  const token = await setup("wasi-setter-denied");
  expect(
    (
      await act("wasi-setter-denied", token, {
        op: "filesystem.writeFile",
        path: "/tmp/existing",
        content: "original",
        encoding: "utf8",
      })
    ).status,
  ).toBe(200);
  const before = Schema.decodeUnknownSync(FileStat)(
    await (
      await act("wasi-setter-denied", token, {
        op: "filesystem.stat",
        path: "/tmp/existing",
        follow: true,
      })
    ).json(),
  );
  const status = Schema.decodeUnknownSync(Status)(
    await (await act("wasi-setter-denied", token, { op: "vm.status" })).json(),
  );
  const readonly = Schema.decodeUnknownSync(TokenResponse)(
    await (
      await post("/v1/sandboxes/wasi-setter-denied/capabilities", admin, {
        permissions: ["read", "execute"],
        expiresInSeconds: 3600,
      })
    ).json(),
  ).token;
  const record = Schema.decodeUnknownSync(RunRecord)(
    await (
      await act("wasi-setter-denied", readonly, {
        op: "process.run",
        id: "denied",
        language: "wasm",
        source: await wasmFixture("setter-denied"),
      })
    ).json(),
  );
  expect(record.output?.result).toBe(42);
  const after = Schema.decodeUnknownSync(FileStat)(
    await (
      await act("wasi-setter-denied", token, {
        op: "filesystem.stat",
        path: "/tmp/existing",
        follow: true,
      })
    ).json(),
  );
  expect(after).toEqual(before);
  const afterStatus = Schema.decodeUnknownSync(Status)(
    await (await act("wasi-setter-denied", token, { op: "vm.status" })).json(),
  );
  expect(afterStatus.generation).toBe(status.generation);
});

test("WASI setters obey checkpoint publication on traps and remain isolated across sandboxes", async () => {
  const token = await setup("wasi-setter-checkpoint");
  const other = await setup("wasi-setter-other");
  for (const [id, credential] of [
    ["wasi-setter-checkpoint", token],
    ["wasi-setter-other", other],
  ] as const)
    expect(
      (
        await act(id, credential, {
          op: "filesystem.writeFile",
          path: "/tmp/existing",
          content: "original",
          encoding: "utf8",
        })
      ).status,
    ).toBe(200);
  const before = Schema.decodeUnknownSync(FileStat)(
    await (
      await act("wasi-setter-checkpoint", token, {
        op: "filesystem.stat",
        path: "/tmp/existing",
        follow: true,
      })
    ).json(),
  );
  const trap = Schema.decodeUnknownSync(RunRecord)(
    await (
      await act("wasi-setter-checkpoint", token, {
        op: "process.run",
        id: "trap",
        language: "wasm",
        source: await wasmFixture("setter-trap"),
      })
    ).json(),
  );
  expect(trap.status).toBe("failed");
  const uncommitted = Schema.decodeUnknownSync(FileStat)(
    await (
      await act("wasi-setter-checkpoint", token, {
        op: "filesystem.stat",
        path: "/tmp/existing",
        follow: true,
      })
    ).json(),
  );
  expect(uncommitted).toEqual(before);
  const synced = Schema.decodeUnknownSync(RunRecord)(
    await (
      await act("wasi-setter-checkpoint", token, {
        op: "process.run",
        id: "sync",
        language: "wasm",
        source: await wasmFixture("setter-synced-trap"),
      })
    ).json(),
  );
  expect(synced.status).toBe("failed");
  const committed = Schema.decodeUnknownSync(FileStat)(
    await (
      await act("wasi-setter-checkpoint", token, {
        op: "filesystem.stat",
        path: "/tmp/existing",
        follow: true,
      })
    ).json(),
  );
  expect(committed.size).toBe(3);
  expect(committed.atimeNs).toBe("111");
  expect(committed.mtimeNs).toBe("222");
  expect(committed.inode).toBe(before.inode);
  const preserved = Schema.decodeUnknownSync(FileStat)(
    await (
      await act("wasi-setter-other", other, {
        op: "filesystem.stat",
        path: "/tmp/existing",
        follow: true,
      })
    ).json(),
  );
  expect(preserved.size).toBe(8);
  expect(preserved.atimeNs).not.toBe("111");
});

test("package installation publishes immutable files, catalog, projections and executable WASI commands together", async () => {
  const token = await setup("packages");
  const binary = new Uint8Array(
    await Bun.file(join(import.meta.dir, "../dist/wasi-inputs.wasm")).arrayBuffer(),
  );
  const bytes = commandPackage(
    binary,
    "probe",
    "1.0.0",
    { CIRRO_MARKER: "package" },
    "/usr/local/share/probe",
  );
  const digest = `sha256:${Buffer.from(await crypto.subtle.digest("SHA-256", bytes)).toString("hex")}`;
  expect(
    (
      await act("packages", token, {
        op: "filesystem.writeFile",
        path: "/tmp/probe.aospkg",
        content: bytes.toString("base64"),
        encoding: "base64",
      })
    ).status,
  ).toBe(200);
  const installedResponse = await act("packages", token, {
    op: "software.install",
    source: { path: "/tmp/probe.aospkg", digest },
  });
  expect(installedResponse.status).toBe(200);
  const installed = Schema.decodeUnknownSync(PackagePreparation.fields.installed)(
    await installedResponse.json(),
  );
  expect(installed.digest).toBe(digest);
  const stat = Schema.decodeUnknownSync(FileStat)(
    await (
      await act("packages", token, {
        op: "filesystem.stat",
        path: "/opt/cirro/pkgs/probe/1.0.0/bin/probe",
        follow: true,
      })
    ).json(),
  );
  expect(stat.mode).toBe(0o555);
  expect(stat.uid).toBe(1000);
  expect(stat.gid).toBe(1001);
  expect(stat.mtimeNs).toBe("123000000000");
  const immutable = Schema.decodeUnknownSync(RunRecord)(
    await (
      await act("packages", token, {
        op: "process.run",
        id: "immutable-times",
        language: "wasm",
        source: await wasmFixture("package-times"),
      })
    ).json(),
  );
  expect(immutable.output?.result).toBe(69);
  const directoryMetadata = Schema.decodeUnknownSync(FileStat)(
    await (
      await act("packages", token, {
        op: "filesystem.stat",
        path: "/opt/cirro/pkgs/probe/1.0.0/bin",
        follow: true,
      })
    ).json(),
  );
  expect(directoryMetadata.mtimeNs).toBe("0");
  const catalog = Schema.decodeUnknownSync(SoftwareCatalog)(
    await (await act("packages", token, { op: "software.list" })).json(),
  );
  expect(catalog).toEqual([installed]);
  const run = Schema.decodeUnknownSync(RunRecord)(
    await (
      await act("packages", token, {
        op: "process.execFile",
        id: "command",
        command: "probe",
        args: ["argument"],
        stdin: { content: "abc", encoding: "utf8" },
      })
    ).json(),
  );
  expect(run.status).toBe("exited");
  expect(run.output?.exitCode).toBe(0);
  expect(run.output?.stdout).toContain(
    'argv=["/opt/cirro/pkgs/probe/1.0.0/bin/probe", "argument"]',
  );
  expect(run.output?.stdout).toContain("marker=package");
  expect(run.output?.stdout).toContain("private=unset");
  expect(run.output?.stdout).toContain("stdin=[97, 98, 99]");
  expect(
    (
      await act("packages", token, {
        op: "software.link",
        packageId: installed.packageId,
        command: "probe",
        alias: "custom",
      })
    ).status,
  ).toBe(200);
  const alias = Schema.decodeUnknownSync(RunRecord)(
    await (
      await act("packages", token, {
        op: "process.execFile",
        id: "alias",
        command: "custom",
        env: { CIRRO_MARKER: "caller" },
      })
    ).json(),
  );
  expect(alias.output?.stdout).toContain("marker=caller");
  const guest = Schema.decodeUnknownSync(RunRecord)(
    await (
      await act("packages", token, {
        op: "javascript.evaluate",
        id: "guest-list",
        expression: "(await tools.call({op:'software.installed'})).length",
      })
    ).json(),
  );
  expect(guest.output?.result).toBe(1);
  for (const action of [
    {
      op: "filesystem.writeFile",
      path: "/opt/cirro/pkgs/probe/1.0.0/bin/probe",
      content: "overwrite",
      encoding: "utf8",
    },
    { op: "filesystem.chmod", path: "/opt/cirro/pkgs/probe/1.0.0/bin/probe", mode: 0o777 },
    { op: "filesystem.remove", path: "/opt", recursive: true },
    { op: "filesystem.remove", path: "/usr/local/share/probe", recursive: false },
    { op: "filesystem.move", from: "/usr/local/share", to: "/tmp/changed" },
    { op: "filesystem.mkdir", path: "/opt/cirro/injected", recursive: true },
  ])
    expect((await act("packages", token, action)).status).toBe(403);
  expect(
    (
      await act("packages", token, {
        op: "filesystem.writeFile",
        path: "/tmp/probe.aospkg",
        content: "changed source",
        encoding: "utf8",
      })
    ).status,
  ).toBe(200);
  const preserved = Schema.decodeUnknownSync(RunRecord)(
    await (
      await act("packages", token, { op: "process.execFile", id: "preserved", command: "probe" })
    ).json(),
  );
  expect(preserved.output?.exitCode).toBe(0);
  expect(
    (await act("packages", token, { op: "software.uninstall", packageId: installed.packageId }))
      .status,
  ).toBe(200);
  expect(
    Schema.decodeUnknownSync(SoftwareCatalog)(
      await (await act("packages", token, { op: "software.installed" })).json(),
    ),
  ).toEqual([]);
  expect(
    (await act("packages", token, { op: "process.execFile", id: "removed", command: "custom" }))
      .status,
  ).toBe(404);
  expect(
    (
      await act("packages", token, {
        op: "filesystem.stat",
        path: "/usr/local/share/probe",
        follow: false,
      })
    ).status,
  ).toBe(404);
});

test("package grants, pinning and invalid projections reject before a new sandbox generation", async () => {
  const token = await setup("package-grants");
  const bytes = commandPackage(
    new Uint8Array(await Bun.file(join(import.meta.dir, "../dist/wasi-inputs.wasm")).arrayBuffer()),
  );
  expect(
    (
      await act("package-grants", token, {
        op: "filesystem.writeFile",
        path: "/tmp/package",
        content: bytes.toString("base64"),
        encoding: "base64",
      })
    ).status,
  ).toBe(200);
  const readonly = Schema.decodeUnknownSync(TokenResponse)(
    await (
      await post("/v1/sandboxes/package-grants/capabilities", admin, {
        permissions: ["read", "execute"],
        expiresInSeconds: 3600,
      })
    ).json(),
  ).token;
  const before = Schema.decodeUnknownSync(Status)(
    await (await act("package-grants", token, { op: "vm.status" })).json(),
  );
  expect(
    (
      await act("package-grants", readonly, {
        op: "software.install",
        source: { path: "/tmp/package" },
      })
    ).status,
  ).toBe(403);
  expect(
    (
      await act("package-grants", token, {
        op: "software.install",
        source: { path: "/tmp/package", digest: `sha256:${"0".repeat(64)}` },
      })
    ).status,
  ).toBe(400);
  expect(
    (
      await act("package-grants", token, {
        op: "software.install",
        source: { url: "https://example.com/package" },
      })
    ).status,
  ).toBe(403);
  expect(
    (
      await act("package-grants", token, {
        op: "software.install",
        source: { path: "/tmp/package", digest: "unrecognized" },
      })
    ).status,
  ).toBe(400);
  const after = Schema.decodeUnknownSync(Status)(
    await (await act("package-grants", token, { op: "vm.status" })).json(),
  );
  expect(after.generation).toBe(before.generation);
  expect(
    Schema.decodeUnknownSync(SoftwareCatalog)(
      await (await act("package-grants", token, { op: "software.list" })).json(),
    ),
  ).toEqual([]);
});

test("concurrent package installers publish one coherent catalog and preserve sandbox isolation", async () => {
  const token = await setup("package-race");
  const other = await setup("package-other");
  const bytes = commandPackage(
    new Uint8Array(await Bun.file(join(import.meta.dir, "../dist/wasi-inputs.wasm")).arrayBuffer()),
  );
  expect(
    (
      await act("package-race", token, {
        op: "filesystem.writeFile",
        path: "/tmp/package",
        content: bytes.toString("base64"),
        encoding: "base64",
      })
    ).status,
  ).toBe(200);
  const replies = await Promise.all(
    [1, 2].map(() =>
      act("package-race", token, { op: "software.install", source: { path: "/tmp/package" } }),
    ),
  );
  expect(replies.filter((response) => response.status === 200)).toHaveLength(1);
  expect(replies.filter((response) => response.status === 409)).toHaveLength(1);
  const packages = Schema.decodeUnknownSync(SoftwareCatalog)(
    await (await act("package-race", token, { op: "software.list" })).json(),
  );
  expect(packages).toHaveLength(1);
  expect(
    Schema.decodeUnknownSync(SoftwareCatalog)(
      await (await act("package-other", other, { op: "software.list" })).json(),
    ),
  ).toEqual([]);
  expect(
    (
      await act("package-other", other, {
        op: "process.execFile",
        id: "isolated",
        command: "probe",
      })
    ).status,
  ).toBe(404);
});

test("package command ownership falls back after removal and conflicting projections leave the catalog unchanged", async () => {
  const token = await setup("package-ownership");
  const binary = new Uint8Array(
    await Bun.file(join(import.meta.dir, "../dist/wasi-inputs.wasm")).arrayBuffer(),
  );
  const first = commandPackage(binary, "probe", "1.0.0", { CIRRO_MARKER: "first" });
  const second = commandPackage(binary, "probe", "2.0.0", { CIRRO_MARKER: "second" });
  for (const [path, bytes] of [
    ["/tmp/first", first],
    ["/tmp/second", second],
  ] as const)
    expect(
      (
        await act("package-ownership", token, {
          op: "filesystem.writeFile",
          path,
          content: bytes.toString("base64"),
          encoding: "base64",
        })
      ).status,
    ).toBe(200);
  const installed = Schema.decodeUnknownSync(PackagePreparation.fields.installed)(
    await (
      await act("package-ownership", token, {
        op: "software.install",
        source: { path: "/tmp/first" },
      })
    ).json(),
  );
  expect(
    (
      await act("package-ownership", token, {
        op: "software.install",
        source: { path: "/tmp/second" },
      })
    ).status,
  ).toBe(200);
  const initial = Schema.decodeUnknownSync(RunRecord)(
    await (
      await act("package-ownership", token, {
        op: "process.execFile",
        id: "first",
        command: "probe",
      })
    ).json(),
  );
  expect(initial.output?.stdout).toContain("marker=first");
  expect(
    (
      await act("package-ownership", token, {
        op: "software.uninstall",
        packageId: installed.packageId,
      })
    ).status,
  ).toBe(200);
  const fallback = Schema.decodeUnknownSync(RunRecord)(
    await (
      await act("package-ownership", token, {
        op: "process.execFile",
        id: "fallback",
        command: "probe",
      })
    ).json(),
  );
  expect(fallback.output?.stdout).toContain("marker=second");
  const conflicting = commandPackage(binary, "conflicting", "1.0.0", {}, "/tmp");
  expect(
    (
      await act("package-ownership", token, {
        op: "filesystem.writeFile",
        path: "/tmp/conflicting",
        content: conflicting.toString("base64"),
        encoding: "base64",
      })
    ).status,
  ).toBe(200);
  const before = Schema.decodeUnknownSync(Status)(
    await (await act("package-ownership", token, { op: "vm.status" })).json(),
  );
  expect(
    (
      await act("package-ownership", token, {
        op: "software.install",
        source: { path: "/tmp/conflicting" },
      })
    ).status,
  ).toBe(409);
  const after = Schema.decodeUnknownSync(Status)(
    await (await act("package-ownership", token, { op: "vm.status" })).json(),
  );
  expect(after.generation).toBe(before.generation);
  expect(
    Schema.decodeUnknownSync(SoftwareCatalog)(
      await (await act("package-ownership", token, { op: "software.list" })).json(),
    ),
  ).toHaveLength(1);
});

test("shell executes installed PATH commands with argv, stdin pipes, output redirection and coherent publication", async () => {
  const token = await setup("shell-packages");
  const binary = new Uint8Array(
    await Bun.file(join(import.meta.dir, "../dist/wasi-inputs.wasm")).arrayBuffer(),
  );
  const bytes = commandPackage(binary);
  expect(
    (
      await act("shell-packages", token, {
        op: "filesystem.writeFile",
        path: "/tmp/package",
        content: bytes.toString("base64"),
        encoding: "base64",
      })
    ).status,
  ).toBe(200);
  expect(
    (
      await act("shell-packages", token, {
        op: "software.install",
        source: { path: "/tmp/package" },
      })
    ).status,
  ).toBe(200);
  const record = Schema.decodeUnknownSync(RunRecord)(
    await (
      await act("shell-packages", token, {
        op: "process.run",
        id: "shell",
        language: "shell",
        source:
          "echo before > /tmp/before; echo input | probe argument > /tmp/output; cat /tmp/before; cat /tmp/output",
      })
    ).json(),
  );
  expect(record.status).toBe("exited");
  expect(record.output?.exitCode).toBe(0);
  expect(record.output?.stdout).toContain("before\n");
  expect(record.output?.stdout).toContain(
    'argv=["/opt/cirro/pkgs/probe/1.0.0/bin/probe", "argument"]',
  );
  expect(record.output?.stdout).toContain("marker=package");
  expect(record.output?.stdout).toContain("stdin=[105, 110, 112, 117, 116, 10]");
  const persisted = Schema.decodeUnknownSync(FileContent)(
    await (
      await act("shell-packages", token, { op: "filesystem.readFile", path: "/tmp/output" })
    ).json(),
  );
  expect(Buffer.from(persisted.content, "base64").toString()).toContain("marker=package");
});

test("shell resolves PATH and qualified executable paths relative to cd while preserving builtin precedence", async () => {
  const token = await setup("shell-path");
  const binary = new Uint8Array(
    await Bun.file(join(import.meta.dir, "../dist/wasi-inputs.wasm")).arrayBuffer(),
  );
  const bytes = commandPackage(binary, "path-provider", "1.0.0", {
    PATH: "/tmp",
    CIRRO_MARKER: "path",
  });
  for (const [path, content] of [
    ["/tmp/package", bytes],
    ["/tmp/local", binary],
  ] as const)
    expect(
      (
        await act("shell-path", token, {
          op: "filesystem.writeFile",
          path,
          content: Buffer.from(content).toString("base64"),
          encoding: "base64",
        })
      ).status,
    ).toBe(200);
  expect(
    (await act("shell-path", token, { op: "filesystem.chmod", path: "/tmp/local", mode: 0o755 }))
      .status,
  ).toBe(200);
  expect(
    (await act("shell-path", token, { op: "software.install", source: { path: "/tmp/package" } }))
      .status,
  ).toBe(200);
  const record = Schema.decodeUnknownSync(RunRecord)(
    await (
      await act("shell-path", token, {
        op: "process.run",
        id: "qualified",
        language: "shell",
        source: "cd /tmp; ./local relative | grep '^argv='; local lookup | grep '^marker='; pwd",
      })
    ).json(),
  );
  expect(record.output?.exitCode).toBe(0);
  expect(record.output?.stdout).toBe('argv=["/tmp/local", "relative"]\nmarker=path\n/tmp\n');
  const direct = Schema.decodeUnknownSync(RunRecord)(
    await (
      await act("shell-path", token, {
        op: "process.execFile",
        id: "direct",
        command: "local",
        env: { PATH: "/tmp" },
      })
    ).json(),
  );
  expect(direct.output?.exitCode).toBe(0);
  expect(direct.output?.stdout).toContain("marker=path");
  expect(
    (
      await act("shell-path", token, {
        op: "process.execFile",
        id: "excluded",
        command: "local",
        env: { PATH: "/not-present" },
      })
    ).status,
  ).toBe(404);
});

test("shell resumes after WASI traps with pending shell writes preserved and only synchronized guest mutations visible", async () => {
  for (const name of ["trap", "synced-trap"]) {
    const id = `shell-${name}`;
    const token = await setup(id);
    const binary = new Uint8Array(
      await Bun.file(join(import.meta.dir, `../dist/wasi-${name}.wasm`)).arrayBuffer(),
    );
    const bytes = commandPackage(binary);
    expect(
      (
        await act(id, token, {
          op: "filesystem.writeFile",
          path: "/tmp/package",
          content: bytes.toString("base64"),
          encoding: "base64",
        })
      ).status,
    ).toBe(200);
    expect(
      (await act(id, token, { op: "software.install", source: { path: "/tmp/package" } })).status,
    ).toBe(200);
    const record = Schema.decodeUnknownSync(RunRecord)(
      await (
        await act(id, token, {
          op: "process.run",
          id: "recover",
          language: "shell",
          source:
            "echo before > /tmp/before; probe || echo recovered > /tmp/recovered; cat /tmp/before; cat /tmp/recovered",
        })
      ).json(),
    );
    expect(record.status).toBe("exited");
    expect(record.output?.exitCode).toBe(0);
    expect(record.output?.stdout).toBe("before\nrecovered\n");
    expect(record.output?.stderr).toContain("WASI execution failed");
    const guestFile = await act(id, token, { op: "filesystem.readFile", path: "/tmp/from-abi" });
    if (name === "trap") expect(guestFile.status).toBe(404);
    else {
      expect(guestFile.status).toBe(200);
      expect(
        Buffer.from(
          Schema.decodeUnknownSync(FileContent)(await guestFile.json()).content,
          "base64",
        ).toString(),
      ).toBe("before trap");
    }
  }
});

test("shell reports missing and non-executable commands and denied capabilities without bypassing grants", async () => {
  const token = await setup("shell-executable");
  const binary = new Uint8Array(
    await Bun.file(join(import.meta.dir, "../dist/wasi-inputs.wasm")).arrayBuffer(),
  );
  expect(
    (
      await act("shell-executable", token, {
        op: "filesystem.writeFile",
        path: "/tmp/local",
        content: Buffer.from(binary).toString("base64"),
        encoding: "base64",
      })
    ).status,
  ).toBe(200);
  const denied = Schema.decodeUnknownSync(RunRecord)(
    await (
      await act("shell-executable", token, {
        op: "process.run",
        id: "denied-exec",
        language: "shell",
        source: "/tmp/local",
      })
    ).json(),
  );
  expect(denied.output?.exitCode).toBe(126);
  const missing = Schema.decodeUnknownSync(RunRecord)(
    await (
      await act("shell-executable", token, {
        op: "process.run",
        id: "missing",
        language: "shell",
        source: "/tmp/missing",
      })
    ).json(),
  );
  expect(missing.output?.exitCode).toBe(127);
  expect(
    (
      await act("shell-executable", token, {
        op: "filesystem.chmod",
        path: "/tmp/local",
        mode: 0o755,
      })
    ).status,
  ).toBe(200);
  const noRead = Schema.decodeUnknownSync(TokenResponse)(
    await (
      await post("/v1/sandboxes/shell-executable/capabilities", admin, {
        permissions: ["execute"],
        expiresInSeconds: 3600,
      })
    ).json(),
  ).token;
  const run = Schema.decodeUnknownSync(RunRecord)(
    await (
      await act("shell-executable", noRead, {
        op: "process.run",
        id: "no-read",
        language: "shell",
        source: "/tmp/local",
      })
    ).json(),
  );
  expect(run.output?.exitCode).toBe(1);
  expect(run.output?.stdout).toBe("");
});

test("Rust WASI allocation and polling preserve byte contents, cursor, userdata, EOF and monotonic sleeps", async () => {
  const token = await setup("wasi-poll");
  const response = await act("wasi-poll", token, {
    op: "process.run",
    id: "poll",
    language: "wasm",
    source: await wasmFixture("poll"),
  });
  expect(response.status).toBe(200);
  const run = Schema.decodeUnknownSync(RunRecord)(await response.json());
  expect(run.status).toBe("exited");
  expect(run.output?.exitCode).toBe(0);
  expect(run.output?.stdout).toBe(
    "allocation preserved cursor and zeros; poll preserved userdata, EOF and clocks\n",
  );
  const file = Schema.decodeUnknownSync(FileContent)(
    await (
      await act("wasi-poll", token, { op: "filesystem.readFile", path: "/tmp/allocated" })
    ).json(),
  );
  expect(Buffer.from(file.content, "base64")).toEqual(
    Buffer.concat([Buffer.from("original"), Buffer.alloc(8)]),
  );
});

test("WASI allocation and poll ABI enforce descriptor rights, pointer bounds, clock flags and earliest deadlines", async () => {
  const token = await setup("wasi-poll-abi");
  expect(
    (
      await act("wasi-poll-abi", token, {
        op: "filesystem.writeFile",
        path: "/tmp/existing",
        content: "original",
        encoding: "utf8",
      })
    ).status,
  ).toBe(200);
  for (const [name, expected] of [
    ["allocate-rights", 76],
    ["allocate-overflow", 42],
    ["poll-abi", 42],
    ["poll-rights", 42],
    ["poll-earliest", 42],
  ] as const) {
    const run = Schema.decodeUnknownSync(RunRecord)(
      await (
        await act("wasi-poll-abi", token, {
          op: "process.run",
          id: name,
          language: "wasm",
          source: await wasmFixture(name),
        })
      ).json(),
    );
    expect(run.output?.result).toBe(expected);
  }
});

test("WASI allocation permission failure restores its buffer and polling stops when its capability expires", async () => {
  const token = await setup("wasi-poll-grants");
  expect(
    (
      await act("wasi-poll-grants", token, {
        op: "filesystem.writeFile",
        path: "/tmp/existing",
        content: "original",
        encoding: "utf8",
      })
    ).status,
  ).toBe(200);
  const readonly = Schema.decodeUnknownSync(TokenResponse)(
    await (
      await post("/v1/sandboxes/wasi-poll-grants/capabilities", admin, {
        permissions: ["read", "execute"],
        expiresInSeconds: 3600,
      })
    ).json(),
  ).token;
  const before = Schema.decodeUnknownSync(Status)(
    await (await act("wasi-poll-grants", token, { op: "vm.status" })).json(),
  );
  const denied = Schema.decodeUnknownSync(RunRecord)(
    await (
      await act("wasi-poll-grants", readonly, {
        op: "process.run",
        id: "allocation",
        language: "wasm",
        source: await wasmFixture("allocate-denied"),
      })
    ).json(),
  );
  expect(denied.output?.result).toBe(42);
  const after = Schema.decodeUnknownSync(Status)(
    await (await act("wasi-poll-grants", token, { op: "vm.status" })).json(),
  );
  expect(after.generation).toBe(before.generation);
  const source = await wasmFixture("poll-expiry");
  const short = Schema.decodeUnknownSync(TokenResponse)(
    await (
      await post("/v1/sandboxes/wasi-poll-grants/capabilities", admin, {
        permissions: ["execute"],
        expiresInSeconds: 1,
      })
    ).json(),
  ).token;
  const expired = Schema.decodeUnknownSync(RunRecord)(
    await (
      await act("wasi-poll-grants", short, {
        op: "process.run",
        id: "expiry",
        language: "wasm",
        source,
      })
    ).json(),
  );
  expect(expired.status).toBe("failed");
  expect(expired.output).toBeNull();
});

test("published libc host filesystem imports preserve modes, detached files and permissions", async () => {
  const token = await setup("host-fs");
  const packageBytes = commandPackage(
    new Uint8Array(await Bun.file(join(import.meta.dir, "../dist/wasi-inputs.wasm")).arrayBuffer()),
  );
  expect(
    (
      await act("host-fs", token, {
        op: "filesystem.writeFile",
        path: "/tmp/extensions.aospkg",
        content: packageBytes.toString("base64"),
        encoding: "base64",
      })
    ).status,
  ).toBe(200);
  expect(
    (
      await act("host-fs", token, {
        op: "software.install",
        source: { path: "/tmp/extensions.aospkg" },
      })
    ).status,
  ).toBe(200);
  const source = Buffer.from(
    await Bun.file(join(import.meta.dir, "../dist/wasi-host-fs.wasm")).arrayBuffer(),
  ).toString("base64");
  const response = await act("host-fs", token, {
    op: "process.run",
    id: "extensions",
    language: "wasm",
    source,
  });
  expect(response.status).toBe(200);
  const record = Schema.decodeUnknownSync(RunRecord)(await response.json());
  expect(record.output?.exitCode).toBe(0);
  expect(record.output?.stdout).toBe("creation modes and detached temporary file passed\n");
  for (const [path, mode] of [
    ["/tmp/mode-explicit", 0o600],
    ["/tmp/mode-default", 0o644],
  ] as const) {
    const stat = Schema.decodeUnknownSync(FileStat)(
      await (await act("host-fs", token, { op: "filesystem.stat", path, follow: true })).json(),
    );
    expect(stat.mode).toBe(mode);
  }
  const entries = Schema.decodeUnknownSync(DirectoryEntries)(
    await (await act("host-fs", token, { op: "filesystem.readdir", path: "/tmp" })).json(),
  );
  expect(entries.some((entry) => entry.name.startsWith(".cirro-tmp-"))).toBe(false);
  const minted = await post("/v1/sandboxes/host-fs/capabilities", admin, {
    permissions: ["read", "execute"],
    expiresInSeconds: 3600,
  });
  const restricted = Schema.decodeUnknownSync(TokenResponse)(await minted.json()).token;
  const denied = Schema.decodeUnknownSync(RunRecord)(
    await (
      await act("host-fs", restricted, {
        op: "process.run",
        id: "denied",
        language: "wasm",
        source,
        args: ["--denied"],
      })
    ).json(),
  );
  expect(denied.output?.exitCode).toBe(0);
  expect(denied.output?.stdout).toBe("temporary file denied\n");
});

test("Python evaluate and file execution preserve source identity, diagnostics and per-run globals", async () => {
  const token = await setup("python-entry");
  const value = Schema.decodeUnknownSync(RunRecord)(
    await (
      await act("python-entry", token, {
        op: "python.evaluate",
        id: "evaluate",
        expression: "{'unicode':'nuvem ☁', 'values':[n*n for n in range(4)]}",
        filePath: "relative.py",
      })
    ).json(),
  );
  expect(value.output?.exitCode).toBe(0);
  expect(value.output?.result).toEqual({ unicode: "nuvem ☁", values: [0, 1, 4, 9] });
  expect(
    (
      await act("python-entry", token, {
        op: "filesystem.writeFile",
        path: "/tmp/code.py",
        content: "marker = 'private'\nprint('file executed')\nmarker",
        encoding: "utf8",
      })
    ).status,
  ).toBe(200);
  const file = Schema.decodeUnknownSync(RunRecord)(
    await (
      await act("python-entry", token, {
        op: "python.executeFile",
        id: "file",
        path: "/tmp/code.py",
      })
    ).json(),
  );
  expect(file.output?.stdout).toBe("file executed\n");
  expect(file.output?.result).toBe("private");
  const empty = Schema.decodeUnknownSync(RunRecord)(
    await (
      await act("python-entry", token, {
        op: "python.evaluate",
        id: "fresh",
        expression: "'marker' in globals()",
      })
    ).json(),
  );
  expect(empty.output?.result).toBe(false);
  const bad = Schema.decodeUnknownSync(RunRecord)(
    await (
      await act("python-entry", token, {
        op: "python.execute",
        id: "syntax",
        source: "if True\n pass",
        filePath: "/tmp/syntax.py",
      })
    ).json(),
  );
  expect(bad.output?.exitCode).toBe(1);
  expect(bad.output?.stderr).toContain("SyntaxError");
  expect(bad.output?.stderr).toContain("/tmp/syntax.py");
  const exception = Schema.decodeUnknownSync(RunRecord)(
    await (
      await act("python-entry", token, {
        op: "python.execute",
        id: "exception",
        source: "print('before exception')\n1/0",
      })
    ).json(),
  );
  expect(exception.output?.exitCode).toBe(1);
  expect(exception.output?.stdout).toBe("before exception\n");
  expect(exception.output?.stderr).toContain("ZeroDivisionError");
});

test("Python tool failures retain codes, sandbox scope and entry read grants", async () => {
  const owner = await setup("python-grants");
  expect(
    (
      await act("python-grants", owner, {
        op: "filesystem.writeFile",
        path: "/tmp/read.py",
        content: "6 * 7",
        encoding: "utf8",
      })
    ).status,
  ).toBe(200);
  const minted = await post("/v1/sandboxes/python-grants/capabilities", admin, {
    permissions: ["read", "execute"],
    expiresInSeconds: 3600,
  });
  const readonly = Schema.decodeUnknownSync(TokenResponse)(await minted.json()).token;
  const denied = Schema.decodeUnknownSync(RunRecord)(
    await (
      await act("python-grants", readonly, {
        op: "python.execute",
        id: "denied",
        source:
          "try:\n await tools.call({'op':'filesystem.writeFile','path':'/tmp/denied','content':'bad','encoding':'utf8'})\nexcept RuntimeError as error:\n print(error.error)\n17",
      })
    ).json(),
  );
  expect(denied.output?.exitCode).toBe(0);
  expect(denied.output?.stdout).toBe("FORBIDDEN\n");
  expect(denied.output?.result).toBe(17);
  expect(
    (
      await act("python-grants", owner, {
        op: "filesystem.stat",
        path: "/tmp/denied",
        follow: true,
      })
    ).status,
  ).toBe(404);
  const executeOnly = Schema.decodeUnknownSync(TokenResponse)(
    await (
      await post("/v1/sandboxes/python-grants/capabilities", admin, {
        permissions: ["execute"],
        expiresInSeconds: 3600,
      })
    ).json(),
  ).token;
  expect(
    (
      await act("python-grants", executeOnly, {
        op: "python.executeFile",
        id: "no-read",
        path: "/tmp/read.py",
      })
    ).status,
  ).toBe(403);
  expect((await act("python-grants", owner, { op: "process.get", id: "no-read" })).status).toBe(
    404,
  );
  const foreign = await setup("python-foreign");
  const isolated = Schema.decodeUnknownSync(RunRecord)(
    await (
      await act("python-foreign", foreign, {
        op: "python.execute",
        id: "isolation",
        source:
          "try:\n await tools.call({'op':'filesystem.readFile','path':'/tmp/read.py'})\nexcept RuntimeError as error:\n print(error.error)\n'isolated'",
      })
    ).json(),
  );
  expect(isolated.output?.stdout).toBe("ENOENT\n");
  expect(isolated.output?.result).toBe("isolated");
});

test("Python instruction and memory limits survive disabled tracing and keep the Worker healthy", async () => {
  const token = await setup("python-budgets");
  for (const [id, source] of [
    ["loop", "while True:\n pass"],
    ["tracing", "import sys\nsys.settrace(None)\nwhile True:\n pass"],
    ["memory", "[0] * 100000000"],
  ] as const) {
    const record = Schema.decodeUnknownSync(RunRecord)(
      await (await act("python-budgets", token, { op: "python.execute", id, source })).json(),
    );
    expect(record.status).toBe("failed");
    expect(record.output).toBeNull();
    const healthy = Schema.decodeUnknownSync(RunRecord)(
      await (
        await act("python-budgets", token, {
          op: "python.evaluate",
          id: `after-${id}`,
          expression: "6 * 7",
        })
      ).json(),
    );
    expect(healthy.output?.result).toBe(42);
  }
});

test("Python output and host-call budgets fail without undoing acknowledged R2 writes", async () => {
  const token = await setup("python-output");
  expect(
    (await act("python-output", token, { op: "config.patch", policy: { maxOutputBytes: 1024 } }))
      .status,
  ).toBe(200);
  const output = Schema.decodeUnknownSync(RunRecord)(
    await (
      await act("python-output", token, {
        op: "python.execute",
        id: "large-output",
        source:
          "await tools.call({'op':'filesystem.writeFile','path':'/tmp/ack','content':'committed','encoding':'utf8'})\nprint('x' * 4096)",
      })
    ).json(),
  );
  expect(output.status).toBe("failed");
  const acknowledged = Schema.decodeUnknownSync(FileContent)(
    await (
      await act("python-output", token, { op: "filesystem.readFile", path: "/tmp/ack" })
    ).json(),
  );
  expect(Buffer.from(acknowledged.content, "base64").toString()).toBe("committed");
  expect(
    (
      await act("python-output", token, {
        op: "config.patch",
        policy: { maxOutputBytes: 1_048_576, interruptBudget: 100_000 },
      })
    ).status,
  ).toBe(200);
  const calls = Schema.decodeUnknownSync(RunRecord)(
    await (
      await act("python-output", token, {
        op: "python.execute",
        id: "calls",
        source:
          "for n in range(257):\n await tools.call({'op':'filesystem.exists','path':'/tmp/ack'})",
      })
    ).json(),
  );
  expect(calls.status).toBe("failed");
  const healthy = Schema.decodeUnknownSync(RunRecord)(
    await (
      await act("python-output", token, { op: "python.evaluate", id: "healthy", expression: "42" })
    ).json(),
  );
  expect(healthy.output?.result).toBe(42);
});
