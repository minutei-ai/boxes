# Cirro

Rust/Wasm agent sandboxes inside Cloudflare Workers. Effect owns validated requests and operation lifetimes; Alchemy owns infrastructure. R2, through its native Worker binding, owns persistent files, code, configuration and execution receipts. The object layout is compatible with S3 storage; an arbitrary external S3 transport is not implemented.

**Experimental. AgentOS parity is the target and is not achieved.** See [the operation inventory](docs/parity.md) before choosing this runtime for a workload.

## What runs today

- Rust filesystem kernel with directories, files, modes, relative symlinks, rename, append and truncate.
- Rust QuickJS for JavaScript, Oxc for TypeScript and Wasmi for standalone Wasm, inside one ordinary Worker.
- JavaScript/TypeScript script execution, expression evaluation and execution of files with sandbox imports, reexports, cycles and symlinks.
- A bounded shell with pipes, redirection, conditionals and initial commands.
- Capability tokens scoped to one sandbox, permission set and expiration.
- Guest RPC for authorized filesystem operations, process inspection and HTTPS GET to explicitly authorized hosts.
- Persistent execution IDs, code digests, completed or failed results, and paginated process summaries.
- Conditional R2 publication: concurrent filesystem changes either commit together or report a conflict.

Cirro does not currently provide Linux compatibility, a complete POSIX shell, npm/pip installation, interactive terminals or reliable background processes. Python is unavailable after the ordinary Worker cutover and returns `501 UNSUPPORTED_RUNTIME`. JavaScript uses QuickJS without Node modules; use `tools.call` for durable files.

## Install and verify

Requires Bun, clang, llvm-ar, Rust with the `wasm32-unknown-unknown` target, and the matching wasm-bindgen CLI:

```sh
bun install --frozen-lockfile
rustup target add wasm32-unknown-unknown
cargo install wasm-bindgen-cli --version 0.2.129 --locked
bun run check
bun run bench
```

`check` builds the actual Worker and Wasm, checks TypeScript, runs Rust Clippy/unit tests and executes integration tests against local workerd and real local R2. Tests include QuickJS isolation, execution and memory exhaustion, TypeScript compilation, and interpreted Rust guest execution. No Cloudflare credentials are required for local verification.

The benchmark records distributions and artifact sizes in [performance-local.json](docs/evidence/performance-local.json). These are local measurements, not production latency or upstream comparisons.

Validation passed 19 Rust tests, 37 workerd integration tests and 28 production checks. Deployment uses the `minutei` profile. [Production evidence](docs/evidence/production.json) covers implemented operations, isolation and resource limits; it includes the explicit Python rejection and does not establish upstream parity. Repeat it with `CIRRO_URL=<deployed-url> bun run live` and the private administrator key in `.env`.

## Deploy

Create a private `.env` file containing a strong `CIRRO_API_KEY`. It is ignored by Git. Use the user-selected `minutei` Alchemy authentication profile, then:

```sh
bun run build
bun run plan
bun run deploy
```

Alchemy provisions one ordinary Worker and one private R2 bucket. There is no Worker Loader or Dynamic Worker execution. A deployment action migrates existing sandbox policies through an administrator endpoint immediately after Worker upload. The stack uses local state for development and Cloudflare state for deployed stages. Never pass R2 credentials or the administrator credential to guest code.

## API

`GET /health` is a health check. `GET /v1/schema` returns the native Effect JSON Schema document for the action contract. All authenticated routes use `Authorization: Bearer <credential>` and return `Cache-Control: no-store`.

Administrator operations:

```sh
curl -X POST "$CIRRO_URL/v1/sandboxes" \
  -H "Authorization: Bearer $CIRRO_API_KEY" \
  -H 'Content-Type: application/json' \
  --data '{"id":"research","policy":{"networkHosts":[],"interruptBudget":1000,"memoryBytes":8388608,"maxOutputBytes":1048576}}'

curl -X POST "$CIRRO_URL/v1/sandboxes/research/capabilities" \
  -H "Authorization: Bearer $CIRRO_API_KEY" \
  -H 'Content-Type: application/json' \
  --data '{"permissions":["read","write","execute"],"expiresInSeconds":3600}'
```

Use the returned token for `POST /v1/sandboxes/research/action`. Permissions are `read`, `write`, `execute`, `network` and `manage`. Configuration updates and disposal require `manage`. Guest tools expose only filesystem and authorized network actions, even when the caller has management permission.

Example action:

```json
{
  "op": "process.run",
  "id": "research-1",
  "language": "javascript",
  "source": "export default async ({tools, console}) => { await tools.call({op:'filesystem.writeFile',path:'/tmp/answer.txt',content:'42',encoding:'utf8'}); console.log('saved'); return 42; };"
}
```

The guest module exports a default function accepting `{ tools, console }`. `tools.call(action)` executes the allowed action inside the trusted Worker. The guest has no administrator credential, direct bucket reference or direct network access. The guest cannot access Worker globals, platform imports, Node modules, bucket bindings or direct fetch. Each execution receives a fresh QuickJS runtime. TypeScript uses the same entry contract after Oxc removes its types and compiles runtime constructs; this is transpilation, not project type checking.

For script-style code, use `javascript.execute` or `typescript.execute` with `id` and `source`. The module receives scoped `tools` and captured `console` as globals. `javascript.evaluate` and `typescript.evaluate` accept `id` and `expression`; the serialized expression value is returned in `output.result`. Optional `filePath` gives inline code its module name and relative import base; its default is `/tmp/__cirro_inline__.mjs`.

Execute a file already in R2 with `javascript.executeFile` or `typescript.executeFile`:

```json
{ "op": "typescript.executeFile", "id": "report-1", "path": "/tmp/main.ts" }
```

File execution and imports require `read` in addition to `execute`. Rust parses imports and reexports; the trusted Worker resolves local JS/TS files from one filesystem snapshot and preloads the graph. Static imports, reexports, literal and computed `import()` calls work. Dynamic imports load their static dependency graph on demand from the current authorized filesystem snapshot, including files the guest just created. Concurrent imports share the native ESM namespace and subsequent imports preserve its cached identity. Relative/absolute paths, extensionless `.js`/`.mjs`/`.ts` paths and directory indexes resolve inside the sandbox. Node/platform imports and npm resolution remain unsupported. `file:` URLs and `import.meta.url` are supported; URL query/fragment identities and import attributes remain pending. Import errors are rejected promises that the guest can catch. Syntax and module resolution errors return a failure before reserving an execution ID. Terminal program artifacts retain the actual static and dynamically imported sources and are addressed by their digest, including on a controlled guest interruption. A platform crash before finalization may still leave an incomplete running receipt. Guest tools reject with an Error containing the domain `code` and `message`.

The parser/compiler uses a fresh Wasm instance per module, with 64 MiB maximum linear memory. Stack exhaustion in one compilation cannot poison later requests. Graphs allow at most 128 modules, 128 imports per module and 8 MiB serialized data. Source compilation is not TypeScript project type checking.

For `language: "shell"`, source is a shell script. For `language: "wasm"`, source is canonical base64 of a module exporting `run() -> i32` and requiring no imports. Wasmi interprets it with fuel and memory limits; arbitrary Wasm is never compiled through Worker JavaScript. WASI support is pending.

Read files using `filesystem.readFile`; the result contains canonical base64 bytes and a byte size. `filesystem.writeFile` accepts `utf8` or canonical `base64`. Unknown fields and unsupported operations are rejected. `filesystem.writeFiles` accepts up to 128 `{path,content,encoding}` entries, creates parent directories and returns per-file success/error results with one final root publication. `filesystem.readFiles` accepts `paths` and returns base64 content or an error per path from one snapshot. Batches allow at most 16 MiB total decoded content. `filesystem.readdirRecursive` accepts `path` with optional `maxDepth` (default 64; 0 lists immediate children) and `exclude` names; it does not descend through child symlinks. `filesystem.realpath` returns the canonical target path.

A `409 CONFLICT` means the filesystem changed during the operation. Read the current state before deciding whether to retry. Reusing an execution ID returns `409 EEXIST`; `process.get` reads its persisted receipt. A guest failure does not roll back filesystem calls it already committed. If a Worker is interrupted before publishing the terminal receipt, its record can remain `running`; reliable recovery/cancellation is not yet implemented.

## Storage and limits

[Architecture](docs/architecture.md) explains commit ordering, isolation and recovery. Files are split into 256 KiB SHA-256 blocks. Existing blocks of the same file are reused. Root publication uses an R2 ETag precondition. Head schema version 2 stores explicit execution budgets; the deploy action migrates version 1 policies to 1,000 interrupt callbacks and 8 MiB guest heaps, preserving files and disposal state. No tenant data is stored in D1, KV or Durable Object SQLite.

Current limits: 16 MiB per file, 64 MiB logical filesystem bytes, 16,384 nodes, 4,096-byte paths, 64 path components, 40 symlink traversals, 256 commands per shell script, 2 MiB input per Rust text command, 1 MiB source and 1 MiB maximum execution output. Block I/O concurrency is four. `interruptBudget` bounds QuickJS interrupt callbacks, with a separate 10,000-microtask and 256-capability-call ceiling. It is a computation budget, not milliseconds. Wasmi receives 1,000 fuel units per budget unit. `memoryBytes` bounds each guest heap from 4 to 32 MiB. The ordinary Worker has a 30-second platform CPU limit; guest execution budgets are enforced by Rust. Output includes serialized result bytes in its limit.

Unreferenced blocks and disposed sandboxes are retained. Safe garbage collection is pending. The filesystem currently loads its bounded metadata manifest for each operation; a paged metadata index is pending for large inventories.

## Inspiration

Inspired by [rivet-dev/agentos](https://github.com/rivet-dev/agentos), inspected at `4d48628304c1ddedafc9d55f60752093fcf6f3d2`. Cirro is an independent implementation; the upstream native sidecar, V8 embedding and Unix socket transport are not used.
