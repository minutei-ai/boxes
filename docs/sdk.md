# Effect SDK

The `@minutei-ai/boxes` SDK targets Effect 4 and ordinary Cloudflare Workers. It uses the native Effect HttpClient supplied by the caller. The package contains generated ESM and TypeScript declarations; Rust, Alchemy, server bindings and credentials are excluded. All request/response Schemas come from the same owner as the server. Schema exports are available from `@minutei-ai/boxes/contracts`.

Install the SDK archive attached to the GitHub SDK release:

```sh
bun add https://github.com/minutei-ai/boxes/releases/download/sdk-v0.1.0/minutei-ai-boxes-0.1.0.tgz
```

Use your application's existing HttpClient Layer, or the native fetch transport in a Worker:

```ts
import { Effect, Redacted } from "effect";
import { FetchHttpClient } from "effect/http";
import { make } from "@minutei-ai/boxes";

const readFile = Effect.gen(function* () {
  const boxes = yield* make({
    url: "https://your-boxes-worker.example",
    token: Redacted.make(scopedCapabilityToken),
  });
  return yield* boxes.action(sandboxId, {
    op: "filesystem.readFile",
    path: "/workspace/result.txt",
  });
}).pipe(Effect.provide(FetchHttpClient.layer));
```

`make` captures the caller's native HttpClient and validated configuration. It exposes `create(input)`, `mintCapability(sandboxId, input)` and `action(sandboxId, action)`. Action results are inferred from their operation discriminator. The complete existing API, including process pagination, wait deadlines, stdin offsets, output cursors, snapshots and policy changes, uses its original contract. Explicitly unsupported server behavior remains unsupported.

In Minutei, acquire the client in the Layer that owns sandbox orchestration and provide the existing HttpClient Layer there. Keep scoped capability clients with their request/run owner; never put actor credentials in a process singleton. The administrator credential belongs only to the control plane; agents receive scoped tokens. Native `FetchHttpClient.Fetch` can supply a Cloudflare service binding's fetch implementation when the deployable provisions that binding. The SDK never provisions infrastructure.

API failures are `BoxesError` with the server's `status`, `error` code and `message`. Use `Effect.catchTag("BoxesError", ...)` to handle declared remote failures. Invalid input and invalid response shapes preserve native Schema/HttpBody errors; transport failures preserve native HttpClient errors. Native Effect interruption cancels the HTTP request. Cancellation of a client request does not cancel a durable sandbox process; explicitly send `process.cancel` for that behavior.

There are no automatic retries, polling loops or local copies of process state. After a lost mutation response or `409`, read current state before deciding whether to resubmit. Compose deadlines and schedules through Effect at the calling domain owner. SDK tests use real Alchemy workerd/R2, plus a native origin Worker for malformed responses and interruption. `bun run build:sdk` generates the distributable and `bun run sdk:proof` verifies the compiled SDK against the authenticated deployed Worker. The package is distributed through GitHub; npm registry publication and direct Minutei integration are separate steps.
