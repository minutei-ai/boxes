# Effect SDK

The `@minutei-ai/boxes` SDK targets Effect 4 and ordinary Cloudflare Workers. Its primary transport is a native Cloudflare service binding. Effect HttpClient owns request construction, interruption and transport errors. The package contains generated ESM and TypeScript declarations; Rust, Alchemy, server bindings and credentials are excluded. All request/response Schemas come from the same owner as the server. Schema exports are available from `@minutei-ai/boxes/contracts`.

Install the SDK archive attached to the GitHub SDK release:

```sh
bun add https://github.com/minutei-ai/boxes/releases/download/sdk-v0.9.0/minutei-ai-boxes-0.9.0.tgz
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

There are no automatic retries, polling loops or local copies of process state. After a lost mutation response or `409`, read current state before deciding whether to resubmit. Compose deadlines and schedules through Effect at the calling domain owner. SDK tests use real Alchemy workerd/R2, a second Worker connected through `Service.local`, and a native origin Worker for malformed responses and interruption. `bun run build:sdk` generates the distributable and `bun run sdk:proof` verifies the compiled SDK against the authenticated deployed Worker. The package is distributed through GitHub; npm registry publication and direct Minutei integration are separate steps.

`filesystem.utimes` sets both timestamps exactly. SDK inputs use `bigint` values for `atimeNs` and `mtimeNs`; JSON clients send canonical unsigned decimal strings within uint64. `follow: false` updates a symlink itself and `follow: true` updates its target. The operation requires `write`, keeps inode identity and bytes unchanged, and sets ctime from the server clock.

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

`createBoxesIsolateDriver(binding, target)` from `@minutei-ai/boxes/tanstack` integrates native Code Mode context acquisition/execution/disposal. With `{ kind: "ephemeral", administratorToken }`, each context creates a fresh sandbox and scoped credential with read/write/execute/manage permissions for its own files and processes. Guest code can use native `tools.call` actions to stage files, run synchronous shell commands and read their results; guest `process.run` accepts only `language: "shell"`, while other runtimes use the existing queued spawn contract. Each shell execution retains the native process receipt, quotas and cancellation path; this does not grant any additional host callback or workspace authority. Network hosts remain empty. Files and background processes belong to the context and are unavailable after disposal; return or publish useful results through an authorized host tool before finishing Code Mode. Its binding callbacks remain owned by the caller; tool authorization and the caller's aggregate budgets remain outside the guest. Context execution preserves void return values, validates injected binding identifiers and limits guest memory/fuel/output. Disposal cancels outstanding runs and writes the sandbox tombstone. Preflight abort prevents acquisition; interruption explicitly cancels the admitted process. Confirmed host effects remain confirmed.

TanStack Code Mode is an optional type-only peer. The current published Code Mode 0.5.2 context signature claims an arbitrary generic result without a decoder. Minutei corrects that declaration to an unknown result, matching the adapter's validated JSON boundary. Its existing native patch also forwards AbortSignal into context configuration. The adapter never imports a TanStack runtime. Tests run the actual adapter between native workerd Workers with R2, including context reuse, void values, abort before entry, cancellation while a host operation is pending, confirmed earlier writes and disposal. The Minutei's Code Mode integration keeps its existing native tool wrappers/events and requires its control-plane `BOXES_API_KEY` binding. Live RPC/consumer and performance comparisons remain separate gates.

For isolated consumer tests, `bun run pack:runtime` packages the already built Worker and Wasm kernels as `@minutei-ai/boxes-runtime`. This separate development artifact exposes `@minutei-ai/boxes-runtime/worker`; Alchemy Runtime starts those modules with local R2 and Queue bindings and connects the caller through `Service.local` with the `Agent` entrypoint. The SDK package remains independent of the runtime artifact. Runtime packaging requires `bun run build` first.

`vm.dispose` requires an unexpired capability with `manage`. Repeating it after confirmed disposal succeeds, including from a replacement Worker. Concurrent disposals converge on the retained deletion marker; a competing live filesystem mutation may still return `CONFLICT`. Reads remain unavailable and the administrator cannot recreate that ID. This marker does not establish physical object reclamation. `bun run dispose:proof` verifies repeated/concurrent disposal and retained authority boundaries against `CIRRO_URL`.

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
