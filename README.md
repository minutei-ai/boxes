# Cirro

Rust/Wasm agent sandboxes inside Cloudflare Workers. Effect owns validated requests and operation lifetimes; Alchemy owns infrastructure. R2, through its native Worker binding, owns persistent files, code, configuration and execution receipts. The object layout is compatible with S3 storage; an arbitrary external S3 transport is not implemented.

**Experimental. AgentOS parity is the target and is not achieved.** See [the operation inventory](docs/parity.md) before choosing this runtime for a workload.

## What runs today

- Rust filesystem kernel with directories, files, modes, relative symlinks, rename, append and truncate.
- Native Dynamic Workers for JavaScript, Python and standalone Wasm.
- A bounded shell with pipes, redirection, conditionals and initial commands.
- Capability tokens scoped to one sandbox, permission set and expiration.
- Guest RPC for authorized filesystem operations, process inspection and HTTPS GET to explicitly authorized hosts.
- Persistent execution IDs, code digests, completed or failed results, and paginated process summaries.
- Conditional R2 publication: concurrent filesystem changes either commit together or report a conflict.

Cirro does not currently provide Linux compatibility, a complete POSIX shell, npm/pip installation, interactive terminals or reliable background processes. The standard Python/Node filesystem APIs are not mounted to R2: use the scoped `TOOLS` capability for durable files.

## Install and verify

Requires Bun, Rust with the `wasm32-unknown-unknown` target, and the matching wasm-bindgen CLI:

```sh
bun install --frozen-lockfile
rustup target add wasm32-unknown-unknown
cargo install wasm-bindgen-cli --version 0.2.129 --locked
bun run check
bun run bench
```

`check` builds the actual Worker and Wasm, checks TypeScript, runs Rust Clippy/unit tests and executes integration tests against local workerd and real local R2. Tests include native Python and compiled Rust guest execution. They require network access for the Python runtime's initial download. No Cloudflare credentials are required for local verification.

The benchmark records distributions and artifact sizes in [performance-local.json](docs/evidence/performance-local.json). These are local measurements, not production latency or upstream comparisons.

## Deploy

Create a private `.env` file containing a strong `CIRRO_API_KEY`. It is ignored by Git. Configure the intended Cloudflare account through Alchemy's authentication profile, then:

```sh
bun run build
bunx alchemy plan alchemy.run.ts --stage prod --no-input
bun run deploy
```

Alchemy provisions the Worker, R2 bucket and Worker Loader binding. The stack uses local state for development and Cloudflare state for deployed stages. Never pass R2 credentials or the administrator credential to guest code.

## API

`GET /health` is a health check. `GET /v1/schema` returns the native Effect JSON Schema document for the action contract. All authenticated routes use `Authorization: Bearer <credential>` and return `Cache-Control: no-store`.

Administrator operations:

```sh
curl -X POST "$CIRRO_URL/v1/sandboxes" \
  -H "Authorization: Bearer $CIRRO_API_KEY" \
  -H 'Content-Type: application/json' \
  --data '{"id":"research","policy":{"networkHosts":[],"cpuMs":1000,"maxOutputBytes":1048576}}'

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

The guest module exports a default function accepting `{ tools, console }`. `tools.call(action)` executes the allowed action inside the trusted Worker. The guest has no administrator credential, direct bucket reference or direct network access. JavaScript can use the Workers native Node compatibility subset; package resolution and full Node compatibility are not implemented.

Python modules export `async def main(tools)`. Convert Python dictionaries with native `pyodide.ffi.to_js` before sending RPC actions:

```python
from pyodide.ffi import to_js

async def main(tools):
    await tools.call(to_js({
        "op": "filesystem.writeFile",
        "path": "/tmp/result.txt",
        "content": "42",
        "encoding": "utf8",
    }))
    print("saved")
    return 42
```

For `language: "shell"`, source is a shell script. For `language: "wasm"`, source is canonical base64 of a module exporting `run()` and requiring no imports. This is standalone Wasm execution, not WASI support.

Read files using `filesystem.readFile`; the result contains canonical base64 bytes and a byte size. `filesystem.writeFile` accepts `utf8` or canonical `base64`. Unknown fields and unsupported operations are rejected.

A `409 CONFLICT` means the filesystem changed during the operation. Read the current state before deciding whether to retry. Reusing an execution ID returns `409 EEXIST`; `process.get` reads its persisted receipt. A guest failure does not roll back filesystem calls it already committed. If a Worker is interrupted before publishing the terminal receipt, its record can remain `running`; reliable recovery/cancellation is not yet implemented.

## Storage and limits

[Architecture](docs/architecture.md) explains commit ordering, isolation and recovery. Files are split into 256 KiB SHA-256 blocks. Existing blocks of the same file are reused. Root publication uses an R2 ETag precondition. No tenant data is stored in D1, KV or Durable Object SQLite.

Current limits: 16 MiB per file, 64 MiB logical filesystem bytes, 16,384 nodes, 4,096-byte paths, 64 path components, 40 symlink traversals, 256 commands per shell script, 2 MiB input per Rust text command, 1 MiB source and 1 MiB maximum execution output. Block I/O concurrency is four. CPU limits are passed to the native Worker Loader; production enforcement is not yet independently verified.

Unreferenced blocks and disposed sandboxes are retained. Safe garbage collection is pending. The filesystem currently loads its bounded metadata manifest for each operation; a paged metadata index is pending for large inventories.

## Inspiration

Inspired by [rivet-dev/agentos](https://github.com/rivet-dev/agentos), inspected at `4d48628304c1ddedafc9d55f60752093fcf6f3d2`. Cirro is an independent implementation; the upstream native sidecar, V8 embedding and Unix socket transport are not used.
