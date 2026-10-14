# Cirro

Rust/Wasm agent sandboxes inside Cloudflare Workers. Effect owns validated requests and operation lifetimes; Alchemy owns infrastructure. R2, through its native Worker binding, owns persistent files, code, configuration and execution receipts. The object layout is compatible with S3 storage; an arbitrary external S3 transport is not implemented.

**Experimental. AgentOS parity is the target and is not achieved.** See [the operation inventory](docs/parity.md) before choosing this runtime for a workload.

## What runs today

- Rust filesystem kernel with directories, files, modes, relative symlinks, rename, append and truncate.
- Rust QuickJS for JavaScript, Oxc for TypeScript and Wasmi for Wasm/WASI, inside one ordinary Worker.
- JavaScript/TypeScript script execution, expression evaluation and execution of files with sandbox imports, reexports, cycles and symlinks.
- A bounded shell with pipes, redirection, conditionals and initial commands.
- Capability tokens scoped to one sandbox, permission set and expiration.
- Guest RPC for authorized filesystem operations, process inspection and HTTPS GET to explicitly authorized hosts.
- Persistent execution IDs, code digests, completed or failed results, and paginated process summaries.
- Conditional R2 publication: concurrent filesystem changes either commit together or report a conflict.

Cirro does not currently provide Linux compatibility, a complete POSIX shell, npm/pip installation, interactive terminals or reliable background processes. Python runs in a fresh RustPython Wasm instance with native instruction and memory limits. JavaScript uses QuickJS without Node modules; use `tools.call` for durable files. Python uses `await tools.call(...)`; synchronous filesystem imports and pip remain pending.

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

Run `bun run check` for the native Rust suites, compiled SDK checks and workerd integration tests. Deployment uses the `minutei` profile. [Production evidence](docs/evidence/production.json) records implemented operations and does not establish upstream parity. Repeat it with `CIRRO_URL=<deployed-url> bun run live` and the private administrator key in `.env`.

## Deploy

Create a private `.env` file containing a strong `CIRRO_API_KEY`. It is ignored by Git. Use the user-selected `minutei` Alchemy authentication profile, then:

```sh
bun run build
bun run plan
bun run deploy
```

Alchemy provisions one ordinary Worker and one private R2 bucket. There is no Worker Loader or Dynamic Worker execution. A deployment action migrates existing sandbox policies, filesystem metadata and WASI input archives through administrator endpoints immediately after Worker upload. The stack uses local state for development and Cloudflare state for deployed stages. Never pass R2 credentials or the administrator credential to guest code.

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

For `language: "shell"`, source is a shell script. For `language: "wasm"`, source is canonical base64 of a module exporting `_start()` for a WASI Preview 1 command or `run() -> i32` for a standalone guest. Wasmi interprets it with fuel and memory limits inside a fresh Rust host instance; arbitrary Wasm is never compiled through Worker JavaScript. WASI file descriptors support R2-backed open/read/write, positional I/O, seek, close and sync, plus captured stdio, clock and entropy. Directory/path operations include mkdir, readdir with cookies, rename, unlink/rmdir and symlink/readlink. Open file descriptions retain their identity and data after replacement or unlink; detached writes do not recreate a path. File stat reports packed UID/GID metadata. File stat and directory entries expose persistent inode identities; stat also exposes nanosecond timestamps. WASI descriptor allocation/resizing preserves the cursor and fills growth with zeros; polling supports buffered file/stdio readiness and realtime/monotonic waits with native event layouts. Descriptor/path timestamp setters preserve full unsigned 64-bit values and honor explicit, NOW and no-op flags. Files publish together at completion; explicit sync creates a durable checkpoint. Unsynced changes disappear after a trap; earlier checkpoints remain. Wasm runs accept optional `args`, `env` and `stdin: {content, encoding}` (`utf8` or `base64`). argv starts with the entry path; the environment contains declared package defaults and supplied overrides. Stdin is a bounded byte stream with EOF after consumption. `wasm.executeFile` loads a binary from a sandbox `path` and additionally requires `read`. The archived JSON program includes binary bytes, argv, environment and stdin. Unsupported syscalls fail explicitly; this is not full WASI or software-package parity.

Read files using `filesystem.readFile`; the result contains canonical base64 bytes and a byte size. `filesystem.writeFile` accepts `utf8` or canonical `base64`. Unknown fields and unsupported operations are rejected. `filesystem.writeFiles` accepts up to 128 `{path,content,encoding}` entries, creates parent directories and returns per-file success/error results with one final root publication. `filesystem.readFiles` accepts `paths` and returns base64 content or an error per path from one snapshot. Batches allow at most 16 MiB total decoded content. `filesystem.readdirRecursive` accepts `path` with optional `maxDepth` (default 64; 0 lists immediate children) and `exclude` names; it does not descend through child symlinks. `filesystem.realpath` returns the canonical target path.

A `409 CONFLICT` means the filesystem changed during the operation. Read the current state before deciding whether to retry. Reusing an execution ID returns `409 EEXIST`; `process.get` reads its persisted receipt. A guest failure does not roll back filesystem calls it already committed. Pending execution and authorization persist in R2. A started execution is never automatically replayed after an uncertain interruption; the delivery/repair path settles its lost observation as failure after the native consumer deadline. Guest state continuation remains open.

## Storage and limits

[Architecture](docs/architecture.md) explains commit ordering, isolation and recovery. Files are split into 256 KiB SHA-256 blocks. Existing blocks of the same file are reused. Root publication uses an R2 ETag precondition. Head schema version 2 stores explicit execution budgets; the deploy action migrates version 1 policies to 1,000 interrupt callbacks and 8 MiB guest heaps, preserving files and disposal state. The filesystem deploy migration upgrades prior manifests to version 3, preserving data and timestamps, assigning missing inode identities, defaulting ownership to zero and initializing the package catalog. New nodes and mutations use the native clock; reads use a no-atime policy. No tenant data is stored in D1, KV or Durable Object SQLite.

WASI input limits: 128 supplied arguments, 128 environment entries, 4,096 bytes per value, 64 KiB serialized argv/environment and 1 MiB stdin. Source remains bounded to 1 MiB encoded text.

Current limits: 16 MiB per file, 64 MiB logical filesystem bytes, 16,384 nodes, 4,096-byte paths, 64 path components, 40 symlink traversals, 256 commands per shell script, 2 MiB input per Rust text command, 1 MiB source and 1 MiB maximum execution output. Block I/O concurrency is four. `interruptBudget` bounds QuickJS interrupt callbacks, with a separate 10,000-microtask and 256-capability-call ceiling. It is a computation budget, not milliseconds. Wasmi receives 1,000 fuel units per budget unit. `memoryBytes` bounds each guest heap from 4 to 32 MiB. The ordinary Worker has a 30-second platform CPU limit; guest execution budgets are enforced by Rust. Output includes serialized result bytes in its limit.

Unreferenced blocks and disposed sandboxes are retained. Safe garbage collection is pending. The filesystem currently loads its bounded metadata manifest for each operation; a paged metadata index is pending for large inventories.

## Inspiration

Inspired by [rivet-dev/agentos](https://github.com/rivet-dev/agentos), inspected at `4d48628304c1ddedafc9d55f60752093fcf6f3d2`. Cirro is an independent implementation; the upstream native sidecar, V8 embedding and Unix socket transport are not used.

## Command packages

Install an upstream v2 `.aospkg` file from a sandbox path or an authorized HTTPS URL. An optional `sha256:<64 lowercase hex>` digest pins its source. Installation requires `manage` and `write`, plus `read` for a sandbox source or `network` for HTTPS. Redirects are rejected. Sources are bounded to 16 MiB and installation shares the existing filesystem quotas.

```json
{ "op": "software.install", "source": { "path": "/tmp/probe.aospkg" } }
```

`software.list` and `software.installed` read the durable catalog. `software.link` takes a `packageId`, declared `command` and optional `alias`; `software.uninstall` removes a package. Ordinary filesystem operations cannot mutate installed files or their declared directory projections. The catalog and files publish together through one conditional R2 root commit.

```json
{
  "op": "process.execFile",
  "id": "command-1",
  "command": "probe",
  "args": ["input"],
  "env": { "MODE": "caller" }
}
```

Installed command execution currently supports WASI. It accepts the same argv/environment/stdin options as file execution; explicit environment values override package defaults. The shell executes installed WASI commands through PATH with pipes and redirections. Qualified executable paths resolve relative to the shell directory; the guest libc working directory still defaults to root. The published `jq` package is verified with its pinned SHA-256 using `CIRRO_URL=... bun run software:proof`; this checks version, stdin filters, file input and a shell pipeline. Host filesystem imports support one-shot creation modes, hidden pathname preopens and anonymous temporary files; direct I/O fails with NOTSUP, and network send/recv on ordinary descriptors reports NOTSOCK. Default release bundles, child working-directory semantics and other command runtimes are still pending. Filesystem deployment migrates existing manifests to version 3, preserving data and timestamps and initializing the package catalog.

Python accepts `python.execute` (`source`), `python.evaluate` (`expression`) and `python.executeFile` (`path`), with a unique execution `id`. Direct source actions accept an optional diagnostic `filePath`; file execution requires `read` as well as `execute`. Scripts support top-level await and return their final expression. Each run has fresh globals, captured stdout/stderr and JSON results. Tool errors raise `RuntimeError` with the server's `error` and `message` attributes. Native code, package installation, persistent contexts and imports from the sandbox filesystem are not implemented yet.

```python
print("running inside the Worker")
await tools.call({"op": "filesystem.writeFile", "path": "/tmp/result", "content": "42", "encoding": "utf8"})
(await tools.call({"op": "filesystem.readFile", "path": "/tmp/result"}))["content"]
```

`filesystem.readFile` accepts optional byte `offset` and `length`; omitted values read the complete file. It verifies only the immutable blocks needed by that range. `filesystem.writeFile` accepts an optional byte `offset`; when provided, the write preserves other bytes and zero-fills a gap before the new content. Without an offset it replaces the complete file. Existing zero-byte positional writes leave metadata and generation unchanged. Positional writes need only the `write` grant and publish through the same conditional R2 root commit. File size remains limited to 16 MiB.

`network.fetch` accepts `url`, optional `method` (GET by default; HEAD, POST, PUT, PATCH, DELETE and OPTIONS supported), optional `headers`, and optional `body: {content, encoding}`. Request bodies support UTF-8 and canonical base64 up to 1 MiB; GET/HEAD reject bodies. The result includes `status`, `headers`, and base64 `content`. Each call requires the `network` grant and an exact HTTPS hostname in the current sandbox policy. Redirects remain responses. Header counts/bytes and response bodies are bounded; transport-managed routing/framing headers are rejected. JavaScript and Python use the same operation through `tools.call`. VM-local servers, sockets, previews and streaming remain pending.

`process.spawn` reserves any existing execution action in R2 and sends a reference through a native Cloudflare Queue to the same ordinary Worker:

```json
{
  "op": "process.spawn",
  "execution": {
    "op": "process.run",
    "id": "background-task",
    "language": "javascript",
    "source": "export default async ({tools}) => { await tools.call({op:'filesystem.writeFile',path:'/tmp/result',content:'done',encoding:'utf8'}); return 42; }"
  }
}
```

The returned receipt is `queued`. Source bytes and original grants remain in R2; Queue messages contain only the object key and ETag. Closing the HTTP connection does not cancel execution. The consumer conditionally claims the receipt before entering the guest, clears the persisted grants, and records `running`. Duplicate deliveries cannot enter the same execution again. Inline, evaluation and file-entry actions retain their existing argv/environment/stdin and permission contracts.

Each queued execution has a 14-minute wall-time budget within the native consumer's 15-minute lifetime. Native fuel, memory and the Worker's 30-second CPU ceiling remain independent. The original capability expiry is enforced at entry and by guest operations; delivery never renews it. The consumer concurrency is one to bound active interpreter heaps. Guest descendants and indefinite server processes remain open.

A five-minute native cron scans R2 for pending work and expired observations, repairing a failed initial Queue send or a lost delivery. `POST /v1/maintenance/process-dispatch` with the administrator credential and `{}` runs the same repair immediately and reports acknowledged notification count. Repair never replays an execution already claimed. After the consumer deadline, an unobserved exit becomes `failed` with no invented exit code or rollback of prior effects. Resuming interrupted interpreter state remains open.

`process.wait` takes `id` and `timeoutMs` (0–25,000) and returns a receipt only after an actual guest exit. Zero performs one observation. An observation timeout returns `408 ETIMEDOUT` without canceling the process; an unobserved exit returns `500 EXECUTION_FAILED`. `process.get` exposes confirmed state. Waiting requires `read`, honors expiry while polling and is available through guest tools. Spawn requires `execute` plus the permissions of its execution action. POSIX signals and interactive stdin remain pending.

`process.cancel` takes `id` and requires `execute`. Its response is a process summary without output or private grants. Queued work becomes `cancelled` without guest entry; active work becomes `cancelling` until the runner observes the request, closes the guest scope, and publishes `cancelled`. Repeated requests against cancelling or terminal work are idempotent. If natural completion is observed first, its real exit remains `exited`. `process.wait` reports cancellation as `409 ECANCELED`, without inventing an exit code.

The runner observes R2 metadata once per second while asynchronous work is pending. A synchronous native interpreter step remains bounded by its existing fuel/memory/CPU controls; cancellation cannot preempt it mid-call. Confirmed earlier filesystem/network effects persist, and already-issued external requests may finish. Later guest steps stop after observation. Private shell changes are discarded when its scope is interrupted; acknowledged WASI checkpoints remain. Interrupted consumer observation is settled after its existing deadline. Cancellation is available through scoped guest tools; POSIX signals/handlers and process trees remain open.

`process.output.read` takes `id`, `after` (null or a byte cursor), `maxBytes` (1–65,536) and `maxEvents` (1–128). It returns captured output text as base64 UTF-8 chunks of at most 4096 bytes, with stream-relative `offset`, absolute byte `cursor`, `nextCursor`, and `hasMore`. Pages present stdout followed by stderr; this does not reconstruct their original interleaving. Byte pages can split a multibyte character, so concatenate decoded bytes before decoding text.

The result distinguishes `availability: "pending"` for active work, `"retained"` for captured terminal output (including a nonzero guest exit), and `"unobserved"` when runtime failure/cancellation has no published output. Empty unobserved pages do not mean the guest printed nothing. Cursors beyond retained bytes and unsupported filters are rejected. `truncated` is false because this path does not evict retained bytes; the runtime output budget still applies. The operation requires `read` and works through scoped guest tools. Original raw WASI stdio bytes and original cross-stream order remain parity gates.

`process.output.readLive` accepts `id`, `after: null | {stdout, stderr}` with independent byte offsets, and the same `maxBytes`/`maxEvents` limits as retained replay. The response has stream-relative event offsets and `nextCursor: {stdout, stderr}`. `hasMore` refers to the currently published snapshot; a running process can emit more later. These independent cursors remain stable when one stream grows before the other.

QuickJS JavaScript/TypeScript, RustPython and Wasmi expose their captured buffers at native suspension points. Shell snapshots follow command boundaries and forward external WASI output according to pipe/redirection routing. Changed snapshots conditionally replace the existing R2 receipt before the host operation continues. `process.get` can therefore contain an output checkpoint while running, with `exitCode: null` and no observed result. Actual guest exit still publishes its real result/code. Failed or cancelled work preserves acknowledged checkpoints without manufacturing an exit. A checkpoint conflict with cancellation stops the writer; rewinding a captured stream is rejected.

The original numeric-cursor `process.output.read` serves stable terminal capture and rejects active partial output with `409 OUTPUT_PENDING`; use the live API during execution. Capture happens at yields or shell command boundaries, not after every synchronous print. Bytes emitted and lost inside an interrupted native step may remain unobserved. Stdout and stderr are retained as immutable, SHA-256-verified 64 KiB R2 blocks. Checkpoints reuse previously confirmed blocks, and paginated reads fetch only blocks intersecting their requested bytes. `process.get` and successful `process.wait` reconstruct the complete public output. Receipts contain stream sizes and block references; deployment migrates older inline receipts unconditionally with ETag fencing, preserving grants, deadlines and captured output. Original cross-stream order and binary WASI bytes remain open.
