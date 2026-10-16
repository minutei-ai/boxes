# Effect SDK

The `@minutei-ai/boxes` SDK targets Effect 4 and ordinary Cloudflare Workers. Its primary transport is a native Cloudflare service binding. Effect HttpClient owns request construction, interruption and transport errors. The package contains generated ESM and TypeScript declarations; Rust, Alchemy, server bindings and credentials are excluded. All request/response Schemas come from the same owner as the server. Schema exports are available from `@minutei-ai/boxes/contracts`.

Version 0.13.0 is an experimental SDK/runtime candidate with queued WASI PTYs, timed terminal reads, R2-backed resize and SIGWINCH, plus same-build cooperative checkpoint recovery. It retains descriptor-based scripts, shared inodes, scoped binding/RPC and automatic ephemeral-context reclamation. Complete AgentOS parity and production performance/cost remain open. Use matching SDK/runtime archives.

Install the SDK archive from the [experimental 0.13.0 release](https://github.com/minutei-ai/boxes/releases/tag/sdk-v0.13.0). Publication, deployment and native remote proof are tracked separately in the [delivery evidence](evidence/sdk-0.13.0-delivery.json):

```sh
bun add https://github.com/minutei-ai/boxes/releases/download/sdk-v0.13.0/minutei-ai-boxes-0.13.0.tgz
```

Use the service binding from the Minutei Worker environment:

```ts
import { Effect, Redacted } from "effect";
import { makeBinding } from "@minutei-ai/boxes";

const readFile = Effect.gen(function* () {
  const boxes = yield* makeBinding(env.BOXES, Redacted.make(scopedCapabilityToken));
  return yield* boxes.action(sandboxId, {
    op: "filesystem.readFile",
    path: "/workspace/result.txt",
  });
});
```

`makeBinding` acquires a native binding transport and captures the scoped redacted credential. It calls `binding.fetch` directly; the internal request URL supplies the API path and does not resolve a public host. Cloudflare Worker globals must be enabled in TypeScript through `@cloudflare/workers-types`. It exposes `create(input)`, `mintCapability(sandboxId, input)` and `action(sandboxId, action)`. Action results are inferred from their operation discriminator. The complete existing API, including process pagination, wait deadlines, stdin offsets, output cursors, snapshots and policy changes, uses its original contract. Explicitly unsupported server behavior remains unsupported.

For related file updates, call `client.action(id, { op: "filesystem.writeFiles", entries })` once through the same binding. Supply at most 128 entries and 16 MiB of total decoded content. Entries execute in order, including repeated paths and hard links, with a result per file; inspect every `success` value. Successful entries publish together. A conflict rejects publication of the batch, so read the current state before deciding whether to retry. Immutable content blocks are deduplicated within the batch and uploaded with bounded concurrency before publication.

At the existing Minutei Alchemy Stack, resolve the deployed Worker through its native resource reference:

```ts
import * as Cloudflare from "alchemy/Cloudflare";

const boxes =
  yield *
  Cloudflare.Worker.ref("Sandbox", {
    stack: "cirro",
    stage: "prod",
  });
```

Add `BOXES: boxes` to the existing Worker resource's `env` so `Cloudflare.InferEnv` owns the binding type. The stack retains its current physical identity `cirro` to preserve deployed storage. Use the authorized `minutei` profile when applying that Stack change.

In Minutei, acquire the client in the Layer that owns sandbox orchestration. Keep scoped capability clients with their request/run owner; never put actor credentials in a process singleton. The administrator credential belongs only to the control plane; agents receive scoped tokens. The SDK never provisions infrastructure. `make({ url, token })` remains available for external clients and requires a caller-provided native HttpClient Layer.

API failures are `BoxesError` with the server's `status`, `error` code and `message`. Use `Effect.catchTag("BoxesError", ...)` to handle declared remote failures. Invalid input and invalid response shapes preserve native Schema/HttpBody errors; transport failures preserve native HttpClient errors. Native Effect interruption cancels the HTTP request. Cancellation of a client request does not cancel a durable sandbox process; explicitly send `process.cancel` for that behavior.

The low-level clients have no automatic mutation retries, process polling loops or local copies of process state. After a lost mutation response or `409`, read current state before deciding whether to resubmit. Compose deadlines and schedules through Effect at the calling domain owner. SDK tests use real Alchemy workerd/R2, a second Worker connected through `Service.local`, and a native origin Worker for malformed responses and interruption. `bun run build:sdk` generates the distributable and `bun run sdk:proof` verifies the compiled SDK against the authenticated deployed Worker. The package is distributed through GitHub; npm registry publication and direct Minutei integration are separate steps.

Shell `process.run` supports stdin `<`/`0<`, stdout `>`/`1>`/`>>`, and stderr `2>`/`2>>` file redirections. Opens happen left to right before execution. A diagnostic uses the last successfully opened stderr target, including when a later open fails. Output targets retain their inode across rename/unlink and need `write`, including append to mode-0200 files without a read grant. Redirected bytes stay outside process output/replay; the command output limit still applies. Descriptor duplication such as `2>&1`, heredocs and original cross-stream write ordering remain unsupported. Streams are buffered and applied at command completion.

Shell source expands captured environment variables with `$NAME` or `${NAME}` and exposes the previous pipeline status through `$?`/`${?}`. Double quotes preserve one field, single quotes and escaped dollar signs remain literal, and unquoted values split on spaces, tabs and newlines. For example, `echo "$VALUE" > "$TARGET"` preserves spaces in both values. Expansion does not reinterpret variable contents as shell syntax. Arguments expand after conditional gates; redirect targets expand immediately before each lexical open. A target expanding to zero or multiple fields fails as ambiguous. Limits are 8192 parser tokens/fragments, 4096 expanded fields and 1 MiB of expanded bytes per argument vector or redirect. Parameter operators, positional parameters, command substitution and unquoted pathname patterns remain unsupported. Unquoted `~` and `~/path` in arguments and redirect targets expand from the captured `HOME`. The replacement remains one field even when it contains spaces or pathname metacharacters, and counts toward the same byte limit. Assignments and lexically recognized `export`/`readonly` operands also expand unquoted `~` after the initial `=` and unquoted `:` delimiters, using the HOME in effect at each assignment. Parameter values are never reparsed for tilde expansion. Quoted or escaped tilde characters remain literal. `~user` lookup and expansion without `HOME` fail explicitly; the sandbox never consults host user records. Custom IFS values are rejected explicitly; the default space/tab/newline separators remain supported.

Shell source supports `NAME=value` assignments, temporary command prefixes, `:` and `export`/`unset`/`readonly`. Values undergo quote removal and supported parameter expansion without field splitting or pathname expansion. A new variable stays local until exported; inherited variables retain their export attribute. Prefixes on ordinary builtins or executable files last for that command. Prefixes on `:`/`unset`/`readonly` persist with export attributes; prefixes on `export` persist but are exported only when named by that builtin or already exported. `export -p` emits reusable quoted declarations; `unset -v` and `--` are supported. Declaration-word treatment requires an unquoted literal `export` or `readonly` command name; a name obtained through expansion keeps ordinary argument splitting. Invalid identifiers in these special builtins terminate a non-pipeline shell with status 2. Pipeline stages isolate variable and working-directory changes.

`readonly NAME[=value]` prevents later assignment, temporary prefixes, `export NAME=value`, repeated `readonly NAME=value` and `unset`, including names declared without a value. Naming an already readonly variable without assigning remains valid. `readonly -p` emits reusable quoted declarations; `--` ends option parsing. Violations use status 2 and terminate a non-pipeline shell, including under negation. A failing pipeline stage leaves the parent shell and its attributes intact. A rejected prefix assignment fails before any redirection is opened. Readonly attributes last for one shell execution and do not change sandbox configuration.

Variables are scoped to one shell execution. They do not patch sandbox configuration, another process or a future shell invocation. Command lookup uses the effective shell PATH and `cd` uses the effective HOME. Tool package defaults still apply at the existing executable-loading boundary when no exported override is provided. Local state is limited to 128 set variables, 128 export declarations, 128 readonly declarations, 4096 UTF-8 bytes per value, 128 UTF-16 units per name and 64 KiB of serialized variable data. Full shell initialization, automatic PWD/OLDPWD maintenance, functions and the remaining POSIX stages remain open. Local and deployed proof are tracked separately in the parity evidence.

For compound scripts, install the digest-pinned upstream `sh` package with `software.install` and invoke it through `process.execFile`. The tested artifact identifies itself as Brush 0.3.0; it runs as guest Wasm in the existing Rust interpreter. Installing a sandbox file requires read/write/manage authority, and execution requires read/execute. The native tests cover functions, conditionals, loops, arithmetic, parameter defaults and creation masks. The runtime supports executable files beginning with `#!/opt/cirro/bin/sh`, passed directly to `process.execFile` after installing that package and setting executable mode with `filesystem.chmod`. Arguments, environment and stdin are forwarded to the installed interpreter. Up to four shebang scripts may form a chain; missing or non-executable interpreters fail before process admission. The entire optional shebang argument is one argument, including spaces. Interpreter binaries are captured before queued execution, while the interpreter reads script bodies from the current sandbox filesystem. WASI programs can also spawn or path-exec these scripts; interpreter paths use the native child cwd. The published Brush package can spawn scripts after `cd`, while its direct relative exec after `cd` still lacks libc-to-runtime cwd synchronization. The runtime also supports descriptor-based shebang fexec through process-local `/dev/fd/N` regular-file aliases, retaining the open inode across rename/unlink. A script descriptor marked close-on-exec or explicitly closed by exec fails with ENOENT before replacing the image. Alias opens are read-only, keep independent offsets and cannot gain descriptor rights. Alias directories, pipes, writes and no-follow stat are unsupported. Descriptor-based scripts have been included since 0.12.0. No interpreter is installed automatically. The built-in `language: "shell"` interpreter keeps its existing bounded grammar.

```ts
yield *
  client.action(id, {
    op: "software.install",
    source: {
      path: "/tmp/sh.aospkg",
      digest: "sha256:f606cc4caa9ba50f7022d681269ca0ea98ccffc0d29f3106a0f18ab593c59412",
    },
  });
yield *
  client.action(id, {
    op: "process.execFile",
    id: "compound-script",
    command: "sh",
    args: ["-c", "for value in one two; do echo $value; done"],
    env: { PATH: "/opt/cirro/bin" },
  });
```

Obtain the package from the [digest-addressed published artifact](https://releases.rivet.dev/agent-os/latest/software/packages/sh/f606cc4caa9ba50f7022d681269ca0ea98ccffc0d29f3106a0f18ab593c59412.aospkg) and stage it at the sandbox path before installation. `umask` starts at 0022 per WASI process, applies to file/directory/anonymous-file creation, is copied into a child, survives exec and is retained by a confirmed same-build heap checkpoint. It does not change the sandbox configuration or another process. A mask never grants filesystem write authority. Unattached terminal raw mode returns ENOTTY. Attached terminal input is included in 0.13.0 as described below; complete shell conformance remains open.

The 0.13.0 runtime supports native WASI `host_process.pty_open(master_ptr, slave_ptr)` descriptors. WASI `fd_read`, `fd_write`, `poll_oneoff`, dup/close and child stdio operate on the real pair; `host_tty.isatty`, `get_size` and `set_raw_mode` use that terminal. The initial size is 80 columns by 24 rows. Input starts with bounded canonical lines, byte editing, echo and transient EOF; raw mode passes bytes unchanged. Both slave output streams share one ordered direction, with CRLF conversion in cooked mode. Buffers are bounded at 64 KiB per direction and use the existing pipe-family ceiling. Native `host_tty.read(pointer, length, timeout_ms)` also uses this terminal: it returns a byte count, zero on timeout/EOF, and accepts `u32::MAX` for an indefinite wait within the execution budget. Zero timeout consumes no bytes. Memory and rights faults fail explicitly. Terminal-specific listing, richer metadata, full termios and foreground job control remain open.

The 0.13.0 SDK/runtime also accepts `stdinMode: "pty"` on `process.spawn` for a WASI execution, including `process.execFile`. This attaches the terminal to stdin, stdout and stderr. Use the existing `process.stdin.write` expected offsets and `process.stdin.close` for input, and `process.output.readLive`/`process.output.read` for ordered raw output bytes in the stdout stream. Exact write retries do not echo twice. `process.wait`, `process.get` and `process.cancel` retain their existing meanings and authorization. The input head, receipt and output blocks remain the durable owners; there is no second session record. A closed input head flushes a partial canonical line and then supplies permanent EOF. Initial input and EOF survive replacement before guest entry, and completed output replays from another Worker without reentering the guest. The digest-pinned published Brush package runs interactive `sh --input-backend minimal -i` and `sh --input-backend reedline -i` in native workerd. Reedline clients must answer terminal cursor-position queries and may use bracketed paste. Native tests cover history recall, clearing a line, file persistence and exit status using fixed cursor-position responses, rather than a rendered terminal. Native tests also verify cooperative same-build active PTY checkpoint/resume in a replacement Worker, preserving partial canonical lines, raw bytes and a parent/child family. Input and EOF appended while parked are delivered once. Cancelling a parked session prevents reentry; stdin status reports closed even when only the terminal process receipt has been published. Arbitrary-crash recovery, cross-build heap migration, published interactive-shell resumption, terminal-specific listing, richer metadata, full job control and published interactive-shell production behavior remain open. The 0.13.0 delivery evidence records synthetic native remote PTY/resize proof; SDK/runtime 0.12.1 predates these terminal operations.

The source runtime after 0.13.0 turns cooked Ctrl-C (`0x03`), Ctrl-\ (`0x1c`) and Ctrl-Z (`0x1a`) into SIGINT, SIGQUIT and SIGTSTP for the attached terminal's foreground process group. These bytes clear the uncommitted line without becoming input or caret echo when a foreground group exists. Each target retains its own signal disposition and mask; restartable reads keep their frame, and default stop/continue behavior is visible to a guest parent through native wait status. Raw mode delivers the same bytes unchanged. Input offsets still count every accepted control byte; exact write retries do not signal twice. Internal PTYs with no foreground group retain caret echo and deliver an empty line instead. Configurable termios/control characters and guest foreground-group setters remain open. This source increment is not included in the published 0.13.0 runtime.

The 0.13.0 API also exposes terminal control through the Effect SDK, native service bindings and scoped guest tools:

```ts
const geometry =
  yield *
  boxes.action(sandboxId, {
    op: "process.terminal.status",
    id: processId,
  });
yield *
  boxes.action(sandboxId, {
    op: "process.terminal.resize",
    id: processId,
    cols: 120,
    rows: 40,
    revision: geometry.revision,
  });
```

Status requires `read`; resize requires `execute`. Dimensions must be integers from 1 through 65,535. A successful resize acknowledges retained state; the running guest observes it cooperatively through its existing input watcher, including after stdin EOF. A changed size advances the revision and queues SIGWINCH to the native foreground group, initially the root process group. Same-size requests with the current revision do not write or signal. On 409, inspect status before deciding to retry; input close/write and resize share one conditional R2 publication. Resize after process settlement returns 409. Changes made before entry or while parked are installed before execution resumes. Rapid updates may coalesce to their latest size; a revision change still signals when the final size equals the old one. Foreground-group setters and complete job control remain open. These APIs require the 0.13.0 runtime and its unconditional input-head cutover; publication, deployment and native production proof are separate gates.

Installing the pinned `jq` package alongside `sh` supports `echo '{"value":42}' | jq .value`, `answer=$(jq -n '21*2')`, heredocs and file redirections. The native tests execute these published programs with an 8 MiB guest linear-memory budget; this does not measure total Worker memory. The current published Brush artifact omits the spawn action for `sh -c 'printf err >&2' 2>&1`, leaving stderr separate. Redirecting both streams into a regular file is covered. Sequential child commands, including three jq invocations and a child file write followed by jq reading that file, execute within one process run. Native Effect scheduling yields between guest turns while children remain active. Each WASI process family shares the existing 256 host-request ceiling; sufficiently long compound scripts fail explicitly at that limit. Full shell conformance remains open.

Sandbox creation accepts `environment`. `config.get` returns it alongside the policy; `config.set` and `config.patch` require `manage` and accept an optional replacement `environment` map. Omitting the map preserves it, `{}` clears configured overrides, and an empty string remains a value. These values are persisted in the same conditional root publication as policy and filesystem state. Readers with `read` can inspect configuration, so it is not a secret store.

Execution merges installed package defaults, sandbox configuration, then the action’s optional `env`, in that order. Every admitted program captures the merged map before reserving its receipt; later configuration edits and Worker replacement do not alter queued inputs. JavaScript/TypeScript expose a guest-local `process.env` without Node host capabilities. Python exposes `os.environ` and `os.getenv` through a restricted native module; this does not provide the full Python `os` module. Mutations of either guest map do not change persisted configuration or later executions. Shell and WASI receive the same captured map, and Worker bindings are never inherited.

The merged environment is limited to 128 entries and 64 KiB serialized JSON. Keys and values require valid UTF-8; values are limited to 4096 bytes. WASI arguments and environment together must also fit 64 KiB. Checks run before executable content reads and process reservation. Oversized merged count/total bytes return `E2BIG`; invalid UTF-8 or oversized individual values return `EINVAL`. Persistent-environment validation and deployment are tracked in the repository’s parity evidence; SDK/runtime publication and Minutei delivery remain separate gates.

`filesystem.appendFile` requires `write`, including for files opened with write-only modes. Content is appended as UTF-8 using the Rust end-of-file range plan; unchanged content blocks are retained without reading them. At most one existing partial block is fetched. An empty append creates a missing file, while an empty append to an existing writable file does not publish a new filesystem head. Failed quota validation occurs before existing-block reads or uploads. Append retains inode identity and follows symlinks; ordinary file reads still require `read`.

`filesystem.truncate` requires `write` and an existing writable regular file. Rust plans the new length: unchanged full blocks are retained, only a changed boundary block is read, and growth is zero-filled. Shrinking on a block boundary or to zero needs no old content reads. Symlinks and hard links retain the same inode, ownership and mode. A successful truncate updates modification/change metadata, including when the requested length is unchanged. Missing targets, readonly files and size/total-byte quota failures are rejected before content reads or uploads.

`filesystem.utimes` sets both timestamps exactly. SDK inputs use `bigint` values for `atimeNs` and `mtimeNs`; JSON clients send canonical unsigned decimal strings within uint64. `follow: false` updates a symlink itself and `follow: true` updates its target. The operation requires `write`, keeps inode identity and bytes unchanged, and sets ctime from the server clock.

`filesystem.link` creates a hard link with `{ from, to, follow }` and requires `write`. Both names share file bytes, ownership, mode, timestamps and inode identity. `follow` selects whether to link a symlink itself or its target; directories and immutable package paths cannot be hard-linked. Removing a name leaves the other aliases intact.

Snapshots export one concrete file or symlink per inode and represent additional names as `{ type: "hardlink", path, target }`. Targets must name concrete file or symlink entries in the same snapshot. Import allocates new inode identities while preserving alias relationships. Readers must support this additional snapshot entry variant.

`filesystem.restore` accepts the snapshot returned by `filesystem.export` and requires both `write` and `manage`. It replaces the entire root in one conditional publication, preserving sandbox identity, policy and credentials. Files, symlinks, modes and ownership are restored; inode identities are newly allocated and timestamps come from the server clock. Software catalog registrations are cleared because they are outside the filesystem snapshot. Existing process receipts remain readable; an old execution checkpoint fails before resuming against a changed filesystem generation.

```ts
const snapshot =
  yield *
  boxes.action(sandboxId, {
    op: "filesystem.export",
    maxBytes: 1048576,
  });
yield * boxes.action(sandboxId, { op: "filesystem.restore", snapshot });
```

`cron.schedule` registers a five-field UTC cron expression or an ISO one-shot timestamp. It requires `manage`, `execute` and `read`; scheduled execution retains the original capability permissions and expiry. Supply an execution action as a template: its `id` is an identity seed, and each occurrence gets a deterministic `cron-…` process ID exposed through `lastProcessId`. `cron.get`, paginated `cron.list` and idempotent `cron.cancel` require `manage`. Listing includes terminal schedule records so failures, cancellation and expiry remain inspectable.

```ts
yield *
  boxes.action(sandboxId, {
    op: "cron.schedule",
    id: "cleanup",
    schedule: "0 * * * *",
    overlap: "skip",
    execution: {
      op: "process.run",
      id: "cleanup-seed",
      language: "shell",
      source: "rm /tmp/cache",
    },
  });
```

`allow` admits independent occurrences, `skip` advances past a due occurrence while the previous process is queued/running, and `queue` retains its due time until that process terminates. One overdue occurrence is admitted per scheduler tick. The ordinary Worker wakes every minute; Cloudflare delivery latency applies, including to one-shot timestamps. Jobs stop at capability expiry and never renew their authority. Cancellation prevents subsequent claims; an already claimed occurrence may finish admission, and cancelling the schedule does not cancel its process. `completed` means a one-shot has no further occurrence, while actual execution outcome remains with `process.get`. Arbitrary host callback closures, persistent grants, cron events and retained per-job run history are not implemented.

Request-scoped agent tools use the named `Agent` Worker entrypoint. This uses native RPC function capabilities across the service binding, with no callback URL. Register its binding in the existing Alchemy Worker environment:

```ts
import type { AgentProtocol } from "@minutei-ai/boxes/rpc";

const agentBinding = Cloudflare.WorkerEntrypoint<AgentProtocol>(boxes, "Agent");
```

Use `makeAgentBinding` from `@minutei-ai/boxes/rpc` with that binding and a scoped token. It retains the HTTP client methods and adds `runWithTools(sandboxId, input, callback)`. Inputs provide `id`, TypeScript module `source`, granted tool names, `maxToolCalls` (1–256) and `timeoutMs` (1–30,000). The source exports its default function and calls `tools.call({ op: "host.call", name, input })`. The callback receives that validated JSON request and returns `{ ok: true, value }` or `{ ok: false, message }`. Inputs and successful values accept JSON or undefined. Omitted input and void tool results remain undefined inside the Rust guest; null remains distinct. Each response is bounded to 1 MiB. The server checks capability expiry, the per-execution name grant and call budget before invoking the callback. The caller still owns actor/workspace authorization and domain tool budgets.

The Rust guest runs with the sandbox's existing fuel/memory/output policy. Source, execution outcome and acknowledged output use existing R2 process receipts. Callbacks remain with the current RPC execution and are released through native disposers. Queued processes and later executions cannot inherit them. Client interruption does not cancel a durable process; use `process.cancel`. Server timeout stops guest continuation, but already accepted callback effects retain their own lifetime and are not rolled back. Domain API errors remain `BoxesError`; native RPC transport failures are `RpcFailure`. The SDK and server both dispose native RPC result references after decoding them.

`createBoxesIsolateDriver(binding, target)` from `@minutei-ai/boxes/tanstack` integrates native Code Mode context acquisition/execution/disposal. With `{ kind: "ephemeral", administratorToken }`, each context creates a fresh sandbox and scoped credential with read/write/execute/manage permissions for its own files and processes. Guest code can use native `tools.call` actions to stage files, run synchronous shell commands and read their results; guest `process.run` accepts only `language: "shell"`, while other runtimes use the existing queued spawn contract. Each shell execution retains the native process receipt, quotas and cancellation path; this does not grant any additional host callback or workspace authority. Network hosts remain empty. Files and background processes belong to the context and are unavailable after disposal; return or publish useful results through an authorized host tool before finishing Code Mode. Its binding callbacks remain owned by the caller; tool authorization and the caller's aggregate budgets remain outside the guest. Context execution preserves void return values, validates injected binding identifiers and limits guest memory/fuel/output. Disposal cancels outstanding runs and writes the sandbox tombstone. The driver, since 0.12.1, then pages through native `vm.reclaim` with management-only cleanup authority until collection completes, with a 60-second collection deadline. Concurrent closes serialize through the context semaphore; a failed collection can be resumed by calling `dispose()` again while execution remains closed. `BoxesContextCleanupError` exposes the sandbox ID and native progress when active receipts block collection; native transport and timeout failures retain their causes. Persistent context disposal retains its files and does not acquire management authority. This cleanup increment starts with SDK 0.12.1; published 0.12.0 artifacts retain the earlier tombstone-only disposal behavior. Native tests cover blocked collection, Queue settlement and a successful second close without reopening execution. Preflight abort prevents acquisition; interruption explicitly cancels the admitted process. Confirmed host effects remain confirmed.

TanStack Code Mode is an optional type-only peer. The current published Code Mode 0.5.2 context signature claims an arbitrary generic result without a decoder. Minutei corrects that declaration to an unknown result, matching the adapter's validated JSON boundary. Its existing native patch also forwards AbortSignal into context configuration. The adapter never imports a TanStack runtime. Tests run the actual adapter between native workerd Workers with R2, including context reuse, void values, abort before entry, cancellation while a host operation is pending, confirmed earlier writes and disposal. The Minutei's Code Mode integration keeps its existing native tool wrappers/events and requires its control-plane `BOXES_API_KEY` binding. Native remote callback RPC is covered by the synthetic consumer proof below; the live Minutei application/model path and performance comparisons remain separate gates.

For isolated consumer tests, `bun run pack:runtime` packages the already built Worker and Wasm kernels as `@minutei-ai/boxes-runtime`. This separate development artifact exposes `@minutei-ai/boxes-runtime/worker`; Alchemy Runtime starts those modules with local R2 and Queue bindings and connects the caller through `Service.local` with the `Agent` entrypoint. The SDK package remains independent of the runtime artifact. Runtime packaging requires `bun run build` first. `bun run pack:runtime [destination]` writes its archive to the selected directory, defaulting to `/tmp`. Before publishing, run `bun run package:proof <sdk.tgz> <runtime.tgz>`. The proof extracts both archives into a temporary consumer, resolves public package exports, typechecks its SDK usage and connects its bundled Worker to the archived runtime through native Alchemy service bindings. It exercises filesystem snapshots, hard-link metadata, RPC callbacks and persistent driver authority/cancellation. Lifecycle cases use delayed Queue delivery. A separate archived runtime uses its native Queue consumer for the PTY proof, including stdin EOF, revision conflicts, agent-controlled resize and native SIGWINCH. Worker replacement has separate runtime tests.

`vm.dispose` requires an unexpired capability with `manage`. Repeating it after confirmed disposal succeeds, including from a replacement Worker. Concurrent disposals converge on the retained deletion marker; a competing live filesystem mutation may still return `CONFLICT`. Reads remain unavailable and the administrator cannot recreate that ID. Active execution observes disposal through its one-second supervisor loop and before settlement; observed disposal cancels the guest and retains acknowledged output in its receipt. Cancellation is cooperative: synchronous native instructions and previously issued external effects cannot be revoked midway. Root disposal and receipt settlement are separate R2 writes. Queued delivery checks disposal before restoring archived code or heap state, so a job waiting for another runtime version can still settle as cancelled after disposal. This marker does not establish physical object reclamation. `bun run dispose:proof` verifies repeated/concurrent disposal and retained authority boundaries against `CIRRO_URL`.

The deployed runtime gives inline executions a recovery deadline of at most 15 minutes, shortened to the requested RPC timeout when supplied. Inspect it with `process.recovery.status` while the sandbox is live. Expired interrupted work settles through native repair and Queue delivery without replaying its program; acknowledged file effects and output remain confirmed. This is not immediate termination. [Production deadline evidence](evidence/inline-deadline-production.json) records both native binding clients, live WASI observation and cleanup. Local seeded orphan tests remain separate from real platform-crash proof.

After disposal, call `client.action(sandboxId, { op: "vm.reclaim", limit: 1000 })` with a management capability to remove retained data in bounded batches. Continue on `pending`; `blocked` lists processes whose native cancellation or recovery must settle first. `complete` finishes the current sweep. The operation removes receipts and output as well as files, code, checkpoints, input and schedules. It keeps the ID tombstone and compact progress record. A later call starts another sweep for late objects; it does not establish an atomic barrier against earlier in-flight writes. The administrator can mint a new token containing only `manage` after disposal, allowing collection when the original token expired. The deployed Worker supports this operation; see [production reclamation evidence](evidence/reclamation-production.json).

Persistent Code Mode uses an existing caller-owned sandbox:

```ts
const driver = createBoxesIsolateDriver(env.BOXES, {
  kind: "persistent",
  sandboxId,
  capabilityToken: Redacted.make(scopedToken),
});
```

The target contract is exported as `BoxesIsolateTarget`. The caller creates the sandbox and supplies a scoped token with `read` and `execute`, plus `write` for file mutations. The driver never mints authority in persistent mode. Closing one context cancels its outstanding process IDs, waits up to the native 25-second observation deadline for terminal receipts and releases callbacks; the sandbox, files and other processes remain under the caller's lifecycle. New contexts and replacement Workers can attach with the same ID and valid authority. The caller owns final sandbox disposal and token renewal. Keep this driver scoped to its authorized actor/run.

`memoryLimit` is sent as a per-execution byte ceiling to RPC. Rust applies the smaller of that ceiling and the current sandbox policy, without changing the persisted policy. The optional `memoryBytes` field of `runWithTools` has the same behavior for JavaScript/TypeScript executions; omission uses the sandbox policy. Files, policy and process receipts persist; JavaScript heap state and host callback closures do not persist between executions. The existing timeout and token expiry still apply.

SDK 0.9 replaces the driver's former credential argument with the explicit target. Existing ephemeral callers pass `{ kind: "ephemeral", administratorToken }`; persistent callers pass `{ kind: "persistent", sandboxId, capabilityToken }`.

`bun run binding:remote:proof` bundles the shared native consumer fixture against an installed SDK package selected by `CIRRO_SDK_DIRECTORY`. Set `ALCHEMY_PROFILE=minutei`, `CIRRO_WORKER` to the existing Worker name and `CIRRO_URL` to its deployed URL; supply `CIRRO_API_KEY` privately. The command creates two authenticated Alchemy edge preview consumers with native default and `Agent` service bindings. The first receives a short-lived read/write/execute capability; the replacement receives only read/execute. It checks callbacks, void results, fresh globals, file retention and authority denials, then reconnects persistent Code Mode contexts across the consumers. Closed contexts refuse late execution, per-context memory limits and the sandbox memory ceiling remain enforced, and a prior completed process receipt survives context closure. Its scoped management client disposes the sandbox and requires a subsequent 404 before printing the report. Preview sessions expire through the native platform lifecycle. The command refuses interactive authentication. [Transport evidence](evidence/remote-binding-production.json) and [persistent Code Mode evidence](evidence/persistent-binding-production.json) cover installed Minutei SDK 0.9.0 and current 0.10.0. They do not exercise the remote Minutei application or model. The persistent proof records an initial consumer error 1101 that did not reproduce after diagnostics were added; its cause remains unresolved.

`bun run reclaim:proof --smoke` creates eight synthetic files and a completed process, checks management and live-root denials, then resumes collection from a second native Cloudflare preview consumer using renewed management authority. Without arguments it stages 1,005 distinct files in ordered batches with deduplicated, bounded-concurrency uploads. Fixture runs verify three persisted file contents and record each batch request duration, including client/HTTP latency. These synthetic proof samples are separate from production performance distributions. `bun run reclaim:proof --collect <sandbox-id>` collects an already disposed root in at most 32 continuation calls and reports `pending`, `blocked` or `complete`. It never disposes an active root in this mode. Set `ALCHEMY_PROFILE=minutei`, `CIRRO_WORKER` and `CIRRO_URL`, and supply `CIRRO_API_KEY` privately. The administrator credential stays in the local process; preview consumers receive only a sandbox token. Returned page sizes may be below the requested limit. The command uses native Effect HttpClient request options to disable Bun connection reuse after an observed socket reset; it does not replay failed submissions automatically.
