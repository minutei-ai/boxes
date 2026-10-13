# Runtime and persistence

The HTTP Worker authenticates the administrator or verifies an HMAC capability. Effect Schema decodes each request with unknown fields rejected. A scoped Effect program loads the R2 head, creates one Rust/Wasm kernel, invokes the domain operation and releases the Wasm handle on exit. Request identity and mutable kernel instances are never process globals. The compiled Wasm module is initialized once.

## Filesystem commits

`sandboxes/<id>/head.json` contains the Rust metadata manifest, generation, sandbox policy and disposal flag. File nodes contain byte size, mode and ordered SHA-256 chunk references; directories and symlinks are metadata nodes. Rust owns canonical paths, ancestor search permissions, modes, quotas and filesystem mutations.

`sandboxes/<id>/blobs/<sha256>` contains immutable 256 KiB data blocks. The trusted Worker hashes inputs with Web Crypto and verifies block digests on reads. Access goes through the scoped native R2 binding; guests cannot address arbitrary bucket objects.

A write validates its filesystem mutation, uploads all required blocks with bounded concurrency, then publishes the new head only if the original ETag still matches. The ETag operation is the visibility boundary. A failure before it leaves the previous filesystem visible. A failure after a successful head write does not undo the committed operation. A racing writer gets a conflict instead of a silent lost update. Read operations retain their original manifest and read its immutable blocks, yielding a consistent snapshot.

Rename modifies the metadata tree and publishes one new root; it does not rewrite file content. Shell scripts retain one private kernel and publish their filesystem changes in one commit after command execution. JavaScript/TypeScript tools commit each filesystem action independently. Consequently, a failed guest can have already committed files, while a rejected shell commit leaves its private changes invisible.

Full bounded metadata is loaded per operation. That is acceptable for the initial validated workloads but is not proof of performance at 16,384 files. Paged metadata, random-access writes, hard links, ownership/timestamps and safe block reclamation remain unimplemented.

## Guest boundary

One ordinary Worker loads precompiled Rust/Wasm modules for its filesystem kernel, QuickJS, Oxc and Wasmi. JavaScript runs in a fresh QuickJS runtime with its own heap, stack ceiling, interrupt budget and microtask ceiling. TypeScript is transpiled by Oxc before entering that runtime. Each module compilation owns a fresh Wasm instance with 64 MiB maximum linear memory; generated native bindings are instantiated through a build-time factory. This contains compiler stack/memory traps instead of retaining a poisoned instance across requests. Guest Wasm is interpreted with Wasmi fuel and memory limits; it is never dynamically compiled using the platform WebAssembly API.

Rust exposes a step/respond protocol for asynchronous capability calls. Effect validates each requested action and executes it using the original trusted sandbox identity, expiration and permission set. Guest JavaScript receives only JSON responses and no host JavaScript references. Capability functions resolve guest promises through native QuickJS handles; dropping an execution releases its pending handles and runtime. No native platform imports, Worker environment, R2 binding or direct network function exist inside QuickJS.

Rust Oxc discovers static imports, reexports and literal dynamic imports. The Worker resolves their canonical paths through the Rust kernel and reads immutable blobs from the initial filesystem snapshot, respecting read permissions and following symlinks. Preloaded graphs preserve native ESM cycles and module identity. Inline script/evaluation and file entry points use the same graph owner. Graphs are limited to 128 modules, 128 imports per module, 1 MiB per module source and 8 MiB serialized data. Computed and lazy imports, package/Node resolution and execution options remain pending. Preflight failures do not reserve execution IDs. Persisted source digests for JS/TS identify the compiled graph rather than a mutable entry pathname.

`interruptBudget` measures interrupt callbacks, not CPU milliseconds. Wasmi uses 1,000 fuel units per budget unit. Memory limits are per guest; the Cloudflare Worker also retains its native aggregate CPU/memory limits. QuickJS has a 512 KiB stack ceiling, 10,000 microtasks and 256 capability requests. Serialized output is bounded. Python execution is explicitly unavailable until a bounded interpreter replaces the removed Dynamic Worker path.

The tool contract excludes administration, process creation and lifecycle mutation. Network calls require both the `network` grant and an exact sandbox policy hostname. Only HTTPS GET is implemented. URL credentials, nonstandard ports and IP destinations are rejected. Redirects are returned without following them. Network bodies and request/guest responses are read through bounded native Effect streams.

Standalone Wasm receives no imports or bindings. Its module must export `run()`. This boundary is tested with an actually compiled Rust guest. POSIX/WASI programs require an additional syscall execution layer and are not supported yet.

The shell is a trusted bounded interpreter, not arbitrary native process execution. Rust owns parsing and text commands, while Effect orchestrates filesystem calls and commits. It is not a complete POSIX shell. Durable access uses the scoped capability API; Node filesystem compatibility and Python execution remain pending.

## Execution receipts

`sandboxes/<id>/code/<sha256>` stores submitted source/binaries. `runs/<id>.json` stores a unique execution ID, language, source digest, timestamps, lifecycle status and terminal output. The initial receipt is conditionally created. A duplicate ID is rejected before execution. Completion conditionally replaces only the original running receipt. Run summaries are encoded into native R2 custom metadata at the same write, so paginated listings fetch only the requested metadata page and do not download each execution output. Cursors and limits pass directly to the owning native API.

A failed transport does not authorize repeating the same execution or deleting its receipt. An interrupted host can leave a `running` receipt even if the guest has stopped. There is no crash recovery, durable spawn, signal handling or reliable cancellation contract yet. Results and filesystem writes are not one cross-object transaction.

Disposal publishes a tombstone in the same head and invalidates future reads/writes/tool calls. It does not reclaim data or instantly terminate already-running guest CPU. Policy changes use the same root commit, require management permission and preserve files. Execution-budget changes apply to subsequently created guest runtimes; subsequent tool calls read the current network policy.

## Infrastructure and production gate

Alchemy declares one sandbox Worker and its R2 object bucket. Its deployment action scans sandbox heads in bounded pages and conditionally migrates version 1 policies to version 2 immediately after Worker upload. The action runs on every deployment using its deployment timestamp input; the action depends on the deployed Worker URL. Version 2 runtime code accepts only the current schema. During the initial cutover, old heads reject runtime reads until the deployment migration converts them. The migration endpoint uses the native R2 binding because the installed Alchemy HTTP bucket client does not forward conditional PUT options. The migration preserves manifests, creation times and tombstones; a concurrent head change aborts migration instead of overwriting it. Runtime source imports provisioning types only as erased imports. Local integration tests use the installed Miniflare native configuration and actual workerd/R2. The tests also invoke the actual local HTTP server.

The user selected the `minutei` Alchemy profile for development and deployment. Local test results do not establish deployed behavior, remote CPU enforcement, production latency or a successful CI run; record those gates separately after executing them.
