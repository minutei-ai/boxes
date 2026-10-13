# Contributing

Install the pinned Bun dependencies and wasm-bindgen CLI, add both `wasm32-unknown-unknown` and `wasm32-wasip1` Rust targets, and run `bun run check`. Formatting is checked with `bun run format:check`. Update the applicable parity row only after a real runtime test demonstrates behavior. New guest operations must test authorization, isolation, failure/interruption and persisted state. Tests must not replace native R2 or execution with mocks.

Run `bun run bench` for performance changes. Record artifact size, workload, distributions and environment. A local workerd benchmark does not establish Cloudflare production latency. Keep fixtures synthetic; private HTML, source code and credentials stay outside the repository.

Maintain executable contracts at their owner. `src/contracts.ts` owns the external Effect Schema API; `crates/kernel` owns serialized kernel persistence and its invariants. Alchemy resources live in `src/resources.ts` and `alchemy.run.ts`. Runtime imports from provisioning must remain type-only.

`409` conflicts require reading current state before deciding to retry. A lost response does not roll back earlier writes. Guest side effects and execution receipts do not currently form an atomic multi-object transaction; do not hide this by replaying submissions.

Before claiming release readiness, close the completion gates in `docs/parity.md`, verify remote CI, deploy through Alchemy and prove the behavior against the authenticated remote Worker. Never publish private authentication configuration or mutate another project's infrastructure.
