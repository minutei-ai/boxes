# Boxes

Rust/Wasm agent sandboxes inside Cloudflare Workers. Effect owns validated requests and operation lifetimes; Alchemy owns infrastructure. R2, through its native Worker binding, owns persistent files, code, configuration, native interpreter heaps and execution receipts. The object layout is compatible with S3 storage; an arbitrary external S3 transport is not implemented.

**Experimental. AgentOS parity is the target and is not achieved.** See [the operation inventory](docs/parity.md) before choosing this runtime for a workload.

Licensed under [Apache 2.0](LICENSE). Maintained by [Minutei AI](https://github.com/minutei-ai).

## What runs today

- Rust filesystem kernel with directories, files, modes, relative symlinks, rename, append and truncate.
- Rust QuickJS for JavaScript, RustPython for Python, Oxc for TypeScript and Wasmi for Wasm/WASI, inside one ordinary Worker.
- JavaScript/TypeScript script execution, expression evaluation and execution of files with sandbox imports, reexports, cycles and symlinks.
- Retained JavaScript/TypeScript/Python contexts through `contextId`, native Rust heaps, compressed R2 packs and the `Agent` service binding; queued and scheduled execution with captured generations is included in 0.22.0.
- A bounded shell with pipes, redirection, conditionals and initial commands.
- Alchemy-provisioned default software in shared immutable R2 blocks, with copy-on-write and a separate private-byte quota. The [image evidence](docs/evidence/default-software-full-local.json) records the tested commands and remaining gaps.
- Capability tokens scoped to one sandbox, permission set and expiration.
- Guest RPC for authorized filesystem operations, process inspection and HTTPS GET to explicitly authorized hosts.
- Persistent execution IDs, code digests, completed or failed results, and paginated process summaries.
- R2-backed queued WASI processes with pipe/PTY input, byte replay, cooperative same-build checkpoints and revision-checked terminal resize.
- Conditional R2 publication: concurrent filesystem changes either commit together or report a conflict.
- Explicit reclamation of disposed sandboxes in bounded R2 batches, with persisted progress and management-only authority.

Boxes does not currently provide Linux compatibility, a complete POSIX shell, npm/pip installation, indefinite processes or complete terminal job control. Python runs in a fresh RustPython Wasm instance with native instruction and memory limits. JavaScript uses QuickJS without Node modules; use `tools.call` for durable files. Python uses `await tools.call(...)`. Version 0.26.0 supports sandbox Python modules and synchronous regular-file `open()`/`io.open()` through the authorized filesystem. Full stdlib, native extensions and pip remain pending.

Version 0.27.0 adds coherent Python open-file inodes across contexts and Worker replacement, including writes after unlink, generation-scoped cleanup and snapshot restoration. It requires filesystem-v6 migration and explicit reset of existing Python contexts. The [delivery evidence](docs/evidence/sdk-0.27.0-delivery.json) records publication, CI, deployment and consumer checks separately.

Unreleased source adds native Python `os.stat`/`lstat`, `listdir`, `readlink`, `getcwd`/`getcwdb` and `chdir`. Relative file opens and relative `sys.path` entries follow the interpreter’s current directory, including after rename and Worker replacement. Pinned `posixpath`/`genericpath` now provide `os.path`, with native path encoding and the bridge’s Linux errno catalog; [library evidence](docs/evidence/python-path-library-local.json) covers real metadata and restored state. Directory descriptors, `scandir` and full `pathlib` remain pending. See [local path evidence](docs/evidence/python-paths-local.json).

Unreleased source also fixes filesystem traversal through symlinks followed by `..`, including batch writes, built-in shell and WASI. The [native path evidence](docs/evidence/semantic-paths-local.json) records physical inode identity, descriptor containment and replacement-Worker checks; ESM specifiers keep their URL normalization.

## Effect SDK

Use [`@minutei-ai/boxes`](docs/sdk.md) from Effect 4 applications and Cloudflare Workers. The SDK shares the server contracts, infers results per operation and calls a native Cloudflare service binding through `makeBinding(env.BOXES, token)`, with scoped redacted credentials and native Effect HttpClient lifetimes.

## Install and verify

Requires Bun, clang, llvm-ar, Rust with the `wasm32-unknown-unknown` and `wasm32-wasip1` targets, and the matching wasm-bindgen CLI:

```sh
bun install --frozen-lockfile
rustup target add wasm32-unknown-unknown wasm32-wasip1
cargo install wasm-bindgen-cli --version 0.2.129 --locked
bun run check
bun run bench
```

`check` builds the actual Worker and Wasm, checks TypeScript, runs Rust Clippy/unit tests and executes integration tests against local workerd and real local R2. Tests include QuickJS isolation, execution and memory exhaustion, TypeScript compilation, and interpreted Rust guest execution. No Cloudflare credentials are required for local verification.

The benchmark records distributions and artifact sizes in [performance-local.json](docs/evidence/performance-local.json). These are local measurements, not production latency or upstream comparisons. `bun run bench:output` measures 4 KiB pages at three cursors with three concurrent readers; [output-local.json](docs/evidence/output-local.json) preserves the before/after observations and their limitations.

Run `bun run check` for the native Rust suites, compiled SDK checks and workerd integration tests. Deployment uses the `minutei` profile. [Production evidence](docs/evidence/production.json) records implemented operations and does not establish upstream parity. Repeat it with `CIRRO_URL=<deployed-url> bun run live` and the private administrator key in `.env`. The probe logs operation names, statuses and request durations without credentials or bodies. It uses separate HTTP connections after an observed Bun connection reset and never retries mutations automatically. Background exit observation continues across native `ETIMEDOUT` responses for at most three minutes, allowing Queue delivery delay while each individual wait remains bounded to 25 seconds. Its live-output fixture suspends for 60 seconds to allow remote inspection and cancellation; local fixture tests retain their six-second default.

## Deploy

Create a private `.env` file containing a strong `CIRRO_API_KEY`. It is ignored by Git. Use the user-selected `minutei` Alchemy authentication profile, then:

```sh
bun run build
bun run plan
bun run deploy
```

Alchemy provisions one ordinary Worker, one private R2 bucket and one native Queue for execution delivery. There is no Worker Loader or Dynamic Worker execution. A deployment action migrates existing sandbox policies, filesystem metadata and WASI input archives through administrator endpoints immediately after Worker upload. The stack uses local state for development and Cloudflare state for deployed stages. Never pass R2 credentials or the administrator credential to guest code.

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

Queued WASI executions transfer their native state through R2 checkpoints after 50 million fuel units or 30 seconds in a blocked root poll/stop wait. A new Queue claim resumes the same native frame, file offsets, child/pipe state and acknowledged output with the original grant and deadline. `process.recovery.status` reports confirmed checkpoints and whether a queued continuation is available. Claims consume the continuation before execution. Unobserved loss during a running claim is settled without replaying effects; arbitrary-crash recovery remains open.

Queued WASI processes can request `stdinMode: "pipe"` on `process.spawn`. Their initial `execution.stdin` bytes are retained before launch, and stdin stays open until `process.stdin.close`. Append with `process.stdin.write` using the current byte `offset`, `content` and `encoding`; inspect `process.stdin.status` after reconnecting. Exact retries at an already accepted offset return the original acknowledgement without appending again; different bytes or concurrent writes return a conflict. Each write accepts at most 64 KiB, with a 16 MiB stream and 1024-block ceiling. Closing requires the current offset and is idempotent. The acknowledgement confirms retained input, not consumption by the guest. EOF drains buffered bytes first. Readers block without occupying the family execution lock; cancel interrupts them. These operations require execute permission. Interactive JS/Python/shell input and PTYs remain open parity work.

WASI input limits: 128 supplied arguments, 128 environment entries, 4,096 bytes per value, 64 KiB serialized argv/environment and 1 MiB stdin. Source remains bounded to 1 MiB encoded text.

Current limits: 16 MiB per file, 64 MiB logical filesystem bytes, 16,384 nodes, 4,096-byte paths, 64 path components, 40 symlink traversals, 256 commands per shell script, 2 MiB input per Rust text command, 1 MiB script source, 8 MiB decoded Wasm modules and 1 MiB maximum execution output. Block I/O concurrency is four. `interruptBudget` bounds QuickJS interrupt callbacks, with a separate 10,000-microtask and 256-capability-call ceiling. It is a computation budget, not milliseconds. Wasmi receives 1,000 fuel units per budget unit. `memoryBytes` bounds each guest heap from 4 to 32 MiB. The ordinary Worker has a 30-second platform CPU limit; guest execution budgets are enforced by Rust. Output includes serialized result bytes in its limit.

Unreferenced blocks and disposed sandboxes are retained. Safe garbage collection is pending. The filesystem currently loads its bounded metadata manifest for each operation; a paged metadata index is pending for large inventories.

## Filesystem snapshots

`filesystem.export` takes `maxBytes` (1 byte to 24 MiB) and returns a `snapshot-export` with `source.format: "boxes-filesystem-snapshot-v1"` and `source.filesystem.entries`. Entries contain absolute paths, octal modes, UID/GID, base64 file bytes or a symlink target. It includes the root and reads one confirmed R2 manifest; it does not follow symlinks. Oversized exports fail with `EFBIG` before fetching file blocks. Unreadable files and corrupt content fail the whole operation. The operation requires a read capability and is available through guest `tools.call`.

`filesystem.chown` takes `path`, unsigned 32-bit `uid`/`gid` and an explicit `follow` flag. It updates virtual inode ownership under a write capability and applies the package write guard. Changed ownership survives Worker replacement and appears in filesystem exports. `bun run ownership:proof` checks host and TypeScript agent calls against `CIRRO_URL`.

`bun run export:proof` validates the public contract against `CIRRO_URL`. `POST /v1/sandboxes` accepts an optional `snapshot` in this exported format. Import creates a new root, validates canonical unique paths and directory parents, and restores canonical base64 bytes, modes, UID/GID and symlinks. Creation is administrator-only and publishes the R2 head once with exclusive creation. Existing IDs return 409. The request is bounded to 25,200,000 bytes; file and manifest quotas also apply. Inode identities and timestamps are initialized for the new sandbox; process state and software installation catalog remain owned by their APIs. `bun run import:proof` checks the roundtrip against `CIRRO_URL`.

## Inspiration

Boxes is inspired by Rivet’s [AgentOS](https://github.com/rivet-dev/agentos), inspected at `4d48628304c1ddedafc9d55f60752093fcf6f3d2`. Boxes is an independent implementation; the upstream native sidecar, V8 embedding and Unix socket transport are not used.

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

Installed command execution currently supports WASI. It accepts the same argv/environment/stdin options as file execution; explicit environment values override package defaults. The shell executes installed WASI commands through PATH with pipes and redirections. Qualified executable paths resolve relative to the shell directory; direct shell command guests still default to root, while native child spawn supplies its validated cwd. The published `jq` and `sh` packages are verified using `CIRRO_URL=... bun run software:proof`, with digest and size pins shared with the native tests. Its compiled Effect SDK checks version, filters, file input, shell compound syntax, umask inheritance, pipelines, heredocs, command substitution and three sequential jq children with an 8 MiB guest budget. The scoped proof disposes its synthetic sandbox after verification. Host filesystem imports support one-shot creation modes, hidden pathname preopens and anonymous temporary files; direct I/O fails with NOTSUP, and network send/recv on ordinary descriptors reports NOTSOCK. Alchemy provisions the default software image; other command runtimes remain pending. Filesystem deployment migrates existing manifests to version 6 in bounded pages, preserving data, timestamps, package catalogs and shared inode identity.

Python accepts `python.execute` (`source`), `python.evaluate` (`expression`) and `python.executeFile` (`path`), with a unique execution `id`. Direct source actions accept optional `filePath` for diagnostics and the initial import directory; file execution requires `read` as well as `execute`. Scripts support top-level await and return their final expression. Calls without `contextId` have fresh globals; retained contexts preserve native globals and closures. Both capture stdout/stderr and JSON results. Tool errors retain the server’s `error` and `message` attributes. The pinned frozen library includes JSON, regex, collections, enum, functools, weak references, heapq, bisect, copy/copyreg and contextlib. Native import machinery loads sandbox `.py` modules and packages with sources bounded to one MiB. Regular-file `open()`/`io.open()` and direct `FileIO` imports provide buffered binary/text streams, creation, append, seek, resize and descriptor duplication. Streams and writable unlinked files survive R2 restoration within one interpreter, with current grants checked on later entries. Ephemeral completion flushes native buffered streams. Version 0.27.0 makes open Python inodes coherent across contexts after unlink. Remaining stdlib, native extensions, pip and full cross-runtime POSIX coherence remain open. Imports consume the sandbox instruction budget. Existing Python contexts require explicit reset when adopting the changed 0.27.0 binary. The [0.27.0 delivery record](docs/evidence/sdk-0.27.0-delivery.json) separates publication, deployment and consumer validation.

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

The result distinguishes `availability: "pending"` for active work, `"retained"` for captured terminal output (including a nonzero guest exit), and `"unobserved"` when runtime failure/cancellation has no published output. Empty unobserved pages do not mean the guest printed nothing. Cursors beyond retained bytes and unsupported filters are rejected. `truncated` is false because this path does not evict retained bytes; the runtime output budget still applies. The operation requires `read` and works through scoped guest tools. Original raw WASI stdio bytes are retained; original cross-stream order remains a parity gate.

`process.output.readLive` accepts `id`, `after: null | {stdout, stderr}` with independent byte offsets, and the same `maxBytes`/`maxEvents` limits as retained replay. The response has stream-relative event offsets and `nextCursor: {stdout, stderr}`. `hasMore` refers to the currently published snapshot; a running process can emit more later. These independent cursors remain stable when one stream grows before the other.

QuickJS JavaScript/TypeScript, RustPython and Wasmi expose their captured buffers at native suspension points. Shell snapshots follow command boundaries and forward external WASI output according to pipe/redirection routing. Changed snapshots conditionally replace the existing R2 receipt before the host operation continues. `process.get` can therefore contain an output checkpoint while running, with `exitCode: null` and no observed result. Actual guest exit still publishes its real result/code. Failed or cancelled work preserves acknowledged checkpoints without manufacturing an exit. A checkpoint conflict with cancellation stops the writer; rewinding a captured stream is rejected.

The original numeric-cursor `process.output.read` serves stable terminal capture and rejects active partial output with `409 OUTPUT_PENDING`; use the live API during execution. Capture happens at yields or shell command boundaries, not after every synchronous print. Bytes emitted and lost inside an interrupted native step may remain unobserved. Stdout and stderr are retained as immutable, SHA-256-verified 64 KiB R2 blocks. Checkpoints reuse previously confirmed blocks, and paginated reads fetch only blocks intersecting their requested bytes. `process.get` and successful `process.wait` reconstruct the complete public output. Receipts contain stream sizes and block references; deployment migrates older inline receipts unconditionally with ETag fencing, preserving grants, deadlines and captured output. WASI output pages preserve raw bytes, including null bytes and invalid UTF-8; text result fields remain UTF-8 views. `cat`, WASI pipelines and shell input/output redirections preserve binary bytes, including append. Rust `head`, `tail`, `sort`, `uniq` and `grep` preserve line bytes; `wc -c` counts raw bytes. Word splitting uses ASCII whitespace and sorting uses byte order. Original cross-stream order remains open.

`bun run host-stat:proof` exercises the native libc metadata ABI against production: file and symlink modes, byte sizes and 512-byte block counts, UID/GID, closed descriptors, pointer validation, private pathname preopens, directory confinement and read grants. These queries use current sandbox metadata; captured stdio reports that it is not a terminal. Remaining host process imports required by other published packages remain open.

`bun run fd-dup:proof` validates duplicate-FD positions, status/descriptor flags, replacement, native WASI renumbering, closure, stdio remapping, quota and read-only rights against the real Worker and checks the resulting R2 file contents. Native WASI child spawn and wait are covered by `bun run wasi-child:proof`; full process parity remains pending.

`bun run pipe:proof` validates native anonymous pipe buffering, aliases, EOF, EPIPE, atomic writes, pointer checks, descriptor quota and poll. It also observes a blocked guest before explicitly cancelling it and verifies retained output. Pipe buffers and endpoint lifetimes use shared Rust ownership; EOF/EPIPE follow the last endpoint reference, including aliases and guest destruction. Open-file buffers retain shared bytes and metadata across inherited references, and closing one store releases only its local cache. Native tests transfer endpoints and files between Wasmi stores and exercise actual guest reads/writes, successful flush and rollback. Native child guests share these resources within an invocation; durable child receipts and full process parity remain pending.

`bun run signal-mask:proof` validates the published native mask ABI: block, unblock, replace and query across both 32-bit halves, exclusion of SIGKILL/SIGSTOP, atomic pointer validation and fresh state per invocation. The same mask governs native signal delivery and is inherited by children unless spawn supplies SETSIGMASK. Native dispositions and the sysroot signal trampoline are supported as described below.

Native `fd_renumber` replaces an existing public descriptor atomically, closes the source and retains its open-file state, descriptor flags and directory cursor. Invalid source or target descriptors leave both resources unchanged; hidden pathname preopens cannot be moved or replaced.

Guest JavaScript, TypeScript and Python tools can call `process.spawn` with the same execution contract as the public API. The scoped capability authorizes source loading and is retained privately for native Queue delivery; spawning grants no additional permissions. Spawn creates an independent durable execution in the same sandbox, rather than a POSIX child with inherited descriptors. With the serial Queue consumer, a queued guest must finish before another queued execution can start; `process.wait` remains bounded and may time out. VM lifecycle and capability administration remain host-only.

WASI entry execution uses resumable 100,000-fuel slices within the configured total instruction budget. Native OutOfFuel resumption retains the stack, and Effect yields between slices. The first slice observes cancellation and publishes output; subsequent checkpoints observe native R2 state after another ten million instruction-fuel units, even if output is unchanged. Large indivisible native operations may exceed a slice, while remaining inside the total budget. Timers alone do not advance reliably during CPU work on deployed Workers. Modules compile eagerly before entry because Wasmi 2.0 lazy translation can return an unrecoverable fuel error while compiling a callee. Compilation remains bounded by module size and the Worker CPU limit; it is outside the guest instruction budget. Module start functions still run during instantiation. `bun run wasi-slices:proof` checks finite computation and cancellation of a loop without host waits. Child scheduling remains pending.

Native WASI `proc_spawn_v3` starts an executable sandbox Wasm image in a child guest in the same invocation. PID/PPID are virtual and local to that invocation; `proc_waitpid_v2` enforces parent ownership, reports observed exit codes, supports WNOHANG and wait-any, and reaps each exit once. Argv preserves argv0 and empty entries; supplied environment and signal masks are retained. Open regular files share buffers, positions and flags; CLOEXEC and ordered close/dup2 actions are applied in the child. Stdout, stderr and stdin ownership are shared. Effect fibers reenter Wasmi cooperatively, with a native semaphore serializing filesystem operations and checkpoint publication. All guests share the original fuel/host-operation budgets, a 16 MiB file-buffer pool and a 64 MiB aggregate declared linear-memory ceiling; at most eight unreaped children are admitted. The root invocation supervises unwaited descendants until completion or cancellation. Child instruction traps terminate that child with status 1, while host failures and exhausted shared budgets fail the invocation. Interpreter state is not durable across Worker replacement. Alternate signal stacks, spawn-v4 and separate durable child receipts remain pending. Unsupported inputs fail explicitly.

Inherited WASI pipes wake through Effect Deferred notifications on guest progress and closure. Blocked reads/writes resume the saved I/O operation with current data/space; poll refreshes pipe readiness and hangup/error flags. No timer-based pipe polling is used. The family admits at most 64 live pipe pairs, each capped at 64 KiB. `bun run inherited-pipe:proof` verifies duplex communication, 128 KiB transfer with backpressure, EOF/EPIPE, poll and cancellation of two blocked guests against the deployed Worker.

Native child spawn resolves its initial cwd and ordered chdir/fchdir actions through the sandbox kernel, including directory symlinks. fchdir follows the staged descriptor table after preceding close/dup2 actions; closed or non-directory descriptors fail before child allocation. Relative executable images resolve from the final cwd. The runtime sets the child `PWD` to that directory for the published wasi-libc initialization contract; supplied `PWD` does not override the runtime cwd. WASI descriptor-relative paths retain their native descriptor semantics. Ordered open actions use the WASI permission, symlink, creation and buffer policy. Opened descriptors support dup2, close and fchdir before exec, including stdout redirection to sandbox files; the parent descriptor table remains intact. Runtime chdir after entry remains pending. A child Wasm instruction trap terminates that child with exit status 1; wait reports no fabricated signal or core dump, and the parent can continue. Root traps, host failures and exhausted shared budgets still fail the invocation.

Native `proc_closefrom` closes public descriptors at or above its unsigned threshold, releases their file buffers and pipe endpoints, and preserves the hidden pathname preopen. A threshold above every public descriptor succeeds without changing them. Ordered spawn `closefrom` actions apply to the child's prepared table only; negative signed thresholds fail with EBADF before PID allocation. Subsequent actions see the resulting table, including earlier opened files.

Native process groups are scoped to one WASI invocation family. Children inherit the parent's current group unless spawn uses SETPGROUP: group zero creates the child's own group, and an explicit group must have a live member in that family. `proc_getpgid` and `proc_setpgid` read and update the same virtual table; invalid IDs and missing groups return errno without mutating the table or allocating a PID. Groups disappear after their final member exits and is reaped. Spawn SETSID creates a new session and a group led by the child; descendants inherit both unless another requested operation changes them. Explicit group joins through spawn or setpgid require a live member in the same session. Combining SETSID with SETPGROUP fails with EPERM before allocation. Native default terminating signals can target a process or group; native user handlers execute in the same Wasmi store. `CIRRO_URL=... bun run groups:proof` verifies inherited, created and explicitly joined groups, plus a child and grandchild in a separate session, in the deployed Worker.

Native `proc_waitpid_v3` exposes Linux raw statuses and supports WNOHANG, WUNTRACED and WCONTINUED, plus PID, any-child and group selectors. Stop/continue events do not reap the process; terminal statuses do. Pointer validation precedes event consumption. State-changing signal calls count toward the shared host-operation budget, bounding queued transitions.

Native `proc_kill` supports existence probes with signal zero, positive process IDs, the caller's group with PID zero, and explicit groups with negative IDs. Default terminating signals are coalesced in a shared per-process 64-bit pending set, respect the process mask and wake pipe, clock and child waits. SIGKILL cannot be blocked and takes precedence. SIGCHLD, SIGURG and SIGWINCH retain their default ignored action. SIGSTOP/SIGTSTP/SIGTTIN/SIGTTOU suspend the current native continuation, and SIGCONT resumes it without re-entering the module. Pending poll timers retain their original absolute deadlines while stopped, so continuation does not restart a relative timeout. SIGCONT also clears pending stop signals, while blocked default terminating signals remain pending until continuation. SIGKILL terminates a stopped guest. `waitpid` reports raw exit code zero and the actual terminating signal separately; a normal `exit(137)` retains exit code 137 and signal zero. Durable cancellation also releases a stopped root while retaining its acknowledged output. No core dump is manufactured. Root results expose the conventional 128-plus-signal exit code. `CIRRO_URL=... bun run signals:proof` checks termination, group delivery, mask inheritance/unblocking, both signal halves and blocked descendants in production.

Native `proc_sigaction` registers default, ignored and user dispositions. User delivery calls the validated `__wasi_signal_trampoline(i32) -> void` export, with the same memory, descriptors and fuel pool. Suspended main and nested handler frames are retained until return. `sa_mask`, automatic self-deferment, SA_NODEFER, SA_RESETHAND, SA_RESTART, SA_SIGINFO metadata, SA_NOCLDSTOP and SA_NOCLDWAIT are supported; SIGKILL/SIGSTOP dispositions cannot be changed. User handlers can perform authorized host filesystem I/O. Caught signals interrupt blocked reads/writes with EINTR unless restart is requested; poll remains interruptible. Successful child waits retain their status after SIGCHLD, and SA_NOCLDSTOP suppresses stop/continue notifications. Spawn inherits ignored dispositions and resets caught ones. SIGCONT resumes a stopped process even when ignored or blocked. Handler nesting is bounded to 32 and shares the job fuel budget. Unsupported flags, missing trampolines and invalid signatures fail before registration. An explicit ignored SIGCHLD disposition or SA_NOCLDWAIT automatically removes exited children; default SIGCHLD behavior retains waitable statuses. Pending waits complete with ECHILD after all selected live children terminate, and SIGCHLD user handlers still run when configured with SA_NOCLDWAIT. The policy at exit applies even if changed after spawn. Pipe endpoints and memory release follow actual guest destruction, independently of status removal. Alternate stacks remain pending. `CIRRO_URL=... bun run handlers:proof` verifies these behaviors against production.

Filesystem timestamps can be set with `filesystem.utimes`, using exact unsigned nanoseconds and explicit symlink following. The Effect SDK accepts `bigint` inputs; the wire contract uses bounded canonical decimal strings. Changes retain inode identity and file bytes and publish through the existing conditional R2 head update.

WASI programs can attenuate descriptor capabilities with `fd_fdstat_set_rights`. Files, stdio and pipes enforce reduced read/write rights; aliases and Queue checkpoints preserve the reduction. Removed base or inheriting bits cannot be added back to that descriptor. `CIRRO_URL=... bun run rights:proof` verifies the native Cargo fixture in production.
