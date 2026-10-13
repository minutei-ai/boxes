# Runtime and persistence

The HTTP Worker authenticates the administrator or verifies an HMAC capability. Effect Schema decodes each request with unknown fields rejected. A scoped Effect program loads the R2 head, creates one Rust/Wasm kernel, invokes the domain operation and releases the Wasm handle on exit. Request identity and mutable kernel instances are never process globals. The compiled Wasm module is initialized once.

## Filesystem commits

`sandboxes/<id>/head.json` contains the Rust metadata manifest, generation, sandbox policy and disposal flag. File nodes contain byte size, mode and ordered SHA-256 chunk references; directories and symlinks are metadata nodes. Rust owns canonical paths, ancestor search permissions, modes, quotas and filesystem mutations.

`sandboxes/<id>/blobs/<sha256>` contains immutable 256 KiB data blocks. The trusted Worker hashes inputs with Web Crypto and verifies block digests on reads. Access goes through the scoped native R2 binding; guests cannot address arbitrary bucket objects.

A write validates its filesystem mutation, uploads all required blocks with bounded concurrency, then publishes the new head only if the original ETag still matches. The ETag operation is the visibility boundary. A failure before it leaves the previous filesystem visible. A failure after a successful head write does not undo the committed operation. A racing writer gets a conflict instead of a silent lost update. Read operations retain their original manifest and read its immutable blocks, yielding a consistent snapshot.

Rename modifies the metadata tree and publishes one new root; it does not rewrite file content. Shell scripts retain one private kernel and publish their filesystem changes in one commit after command execution. JavaScript/Python tools commit each filesystem action independently. Consequently, a failed guest can have already committed files, while a rejected shell commit leaves its private changes invisible.

Full bounded metadata is loaded per operation. That is acceptable for the initial validated workloads but is not proof of performance at 16,384 files. Paged metadata, random-access writes, hard links, ownership/timestamps and safe block reclamation remain unimplemented.

## Guest boundary

The native Worker Loader receives JavaScript/Python/Wasm modules, explicit CPU/subrequest limits and `globalOutbound: null`. JavaScript and Python receive only a loopback `Guest` service and an output limit. Loopback props retain the trusted sandbox ID, expiration and permissions; props and host environment are inaccessible to the guest. Every tool call validates the action, checks expiry/permission and loads the current sandbox state.

The tool contract excludes administration, process creation and lifecycle mutation. Network calls require both the `network` grant and an exact sandbox policy hostname. Only HTTPS GET is implemented. URL credentials, nonstandard ports and IP destinations are rejected. Redirects are returned without following them. Network bodies and request/guest responses are read through bounded native Effect streams.

Standalone Wasm receives no imports or bindings. Its module must export `run()`. This boundary is tested with an actually compiled Rust guest. POSIX/WASI programs require an additional syscall execution layer and are not supported yet.

The shell is a trusted bounded interpreter, not arbitrary native process execution. Rust owns parsing and text commands, while Effect orchestrates filesystem calls and commits. It is not a complete POSIX shell. Node/Python standard filesystem libraries use their platform runtime, not Cirro's R2 mount; durable access uses the scoped RPC API.

## Execution receipts

`sandboxes/<id>/code/<sha256>` stores submitted source/binaries. `runs/<id>.json` stores a unique execution ID, language, source digest, timestamps, lifecycle status and terminal output. The initial receipt is conditionally created. A duplicate ID is rejected before execution. Completion conditionally replaces only the original running receipt. Run summaries are encoded into native R2 custom metadata at the same write, so paginated listings fetch only the requested metadata page and do not download each execution output. Cursors and limits pass directly to the owning native API.

A failed transport does not authorize repeating the same execution or deleting its receipt. An interrupted host can leave a `running` receipt even if the guest has stopped. There is no crash recovery, durable spawn, signal handling or reliable cancellation contract yet. Results and filesystem writes are not one cross-object transaction.

Disposal publishes a tombstone in the same head and invalidates future reads/writes/tool calls. It does not reclaim data or instantly terminate already-running guest CPU. Policy changes use the same root commit, require management permission and preserve files. CPU changes apply to subsequently created isolates; subsequent tool calls read the current network policy.

## Infrastructure and production gate

Alchemy declares one sandbox Worker, its R2 object bucket and the native Worker Loader. Runtime source imports provisioning types only as erased imports. Local integration tests use the installed Miniflare native configuration and actual workerd/R2. The tests also invoke the actual local HTTP server.

Production plan/deploy is currently blocked by the selected `default` Alchemy profile requiring Cloudflare OAuth scopes. A noninteractive refresh returned `login failed`. No deployed endpoint, remote CPU enforcement, production latency or successful CI run is claimed by local test results.
