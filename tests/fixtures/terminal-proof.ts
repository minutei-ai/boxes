import { Effect, Schedule, Schema, Struct } from "effect";
import type { make } from "../../src/sdk";
import {
  AgentRequest,
  InputReceipt,
  RunRecord,
  TerminalGeometry,
  WasmProgram,
} from "../../src/contracts";

export const TerminalProofInput = AgentRequest.mapFields((fields) => ({
  ...Struct.pick(fields, ["sandboxId", "token"]),
  source: WasmProgram.fields.source,
  foregroundSource: WasmProgram.fields.source,
  rawOwners: Schema.Struct({
    parent: WasmProgram.fields.source,
    children: Schema.Struct({
      normal: WasmProgram.fields.source,
      closed: WasmProgram.fields.source,
      trap: WasmProgram.fields.source,
      signal: WasmProgram.fields.source,
      exec: WasmProgram.fields.source,
      failed: WasmProgram.fields.source,
      background: WasmProgram.fields.source,
      replacement: WasmProgram.fields.source,
    }),
  }),
}));
export const TerminalProof = Schema.Struct({
  initial: TerminalGeometry,
  resized: TerminalGeometry,
  terminal: RunRecord,
  agent: RunRecord,
  input: InputReceipt,
  staleRevision: Schema.Literal(409),
  foreignSandbox: Schema.Literal(401),
  foreground: RunRecord,
  rawOwners: RunRecord,
});

export const terminalProof = Effect.fn("proof.terminal")(function* (
  client: Effect.Success<ReturnType<typeof make>>,
  sandboxId: typeof TerminalProofInput.Type.sandboxId,
  source: typeof TerminalProofInput.Type.source,
  foregroundSource: typeof TerminalProofInput.Type.foregroundSource,
  owners: typeof TerminalProofInput.Type.rawOwners,
) {
  yield* client.action(sandboxId, {
    op: "process.spawn",
    stdinMode: "pty",
    execution: { op: "process.run", id: "terminal-live", language: "wasm", source },
  });
  const page = client.action(sandboxId, {
    op: "process.output.readLive",
    id: "terminal-live",
    after: null,
    maxBytes: 4096,
    maxEvents: 16,
  });
  const observed = Effect.fn("proof.terminal.observe")((marker: string) =>
    Effect.repeat(page, {
      until: (page) =>
        Effect.succeed(
          Buffer.concat(page.events.map((event) => Buffer.from(event.data, "base64"))).includes(
            Buffer.from(marker),
          ),
        ),
      schedule: Schedule.spaced("100 millis"),
    }).pipe(Effect.timeout("25 seconds")),
  );
  yield* observed("ready\n");
  const initial = yield* client.action(sandboxId, {
    op: "process.terminal.status",
    id: "terminal-live",
  });
  if (initial.cols !== 80 || initial.rows !== 24 || initial.revision !== 0)
    return yield* Effect.die("Unexpected initial terminal geometry");
  yield* client.action(sandboxId, { op: "process.stdin.close", id: "terminal-live", offset: 0 });
  yield* observed("eof-ready\n");
  yield* client.action(sandboxId, {
    op: "process.terminal.resize",
    id: "terminal-live",
    cols: 120,
    rows: 40,
    revision: 0,
  });
  yield* observed("after-one\n");
  const same = yield* client.action(sandboxId, {
    op: "process.terminal.resize",
    id: "terminal-live",
    cols: 120,
    rows: 40,
    revision: 1,
  });
  if (same.cols !== 120 || same.rows !== 40 || same.revision !== 1)
    return yield* Effect.die("No-op resize changed geometry");
  const stale = yield* client
    .action(sandboxId, {
      op: "process.terminal.resize",
      id: "terminal-live",
      cols: 121,
      rows: 41,
      revision: 0,
    })
    .pipe(Effect.result);
  if (
    stale._tag !== "Failure" ||
    stale.failure._tag !== "BoxesError" ||
    stale.failure.status !== 409
  )
    return yield* Effect.die("Stale terminal revision did not fail with 409");
  const foreign = yield* client
    .action(`${sandboxId}-other`, {
      op: "process.terminal.resize",
      id: "terminal-live",
      cols: 100,
      rows: 30,
      revision: 1,
    })
    .pipe(Effect.result);
  if (
    foreign._tag !== "Failure" ||
    foreign.failure._tag !== "BoxesError" ||
    foreign.failure.status !== 401
  )
    return yield* Effect.die("Cross-sandbox terminal control was not denied");
  const agent = yield* client.action(sandboxId, {
    op: "process.run",
    id: "terminal-agent",
    language: "typescript",
    source:
      'export default async ({tools}) => { const before = await tools.call({op:"process.terminal.status",id:"terminal-live"}); return await tools.call({op:"process.terminal.resize",id:"terminal-live",cols:100,rows:30,revision:before.revision}); }',
  });
  if (agent.status !== "exited" || agent.output?.exitCode !== 0)
    return yield* Effect.die("Guest terminal controller did not complete");
  const resized = yield* Schema.decodeUnknownEffect(TerminalGeometry)(agent.output.result);
  if (resized.cols !== 100 || resized.rows !== 30 || resized.revision !== 2)
    return yield* Effect.die("Guest terminal controller returned unexpected geometry");
  const terminal = yield* client.action(sandboxId, {
    op: "process.wait",
    id: "terminal-live",
    timeoutMs: 25000,
  });
  if (
    terminal.status !== "exited" ||
    terminal.output?.exitCode !== 0 ||
    terminal.output.stdout !== "ready\neof-ready\nwinch\nafter-one\nwinch\ndone\n" ||
    terminal.output.stderr !== ""
  )
    return yield* Effect.die("Native terminal signal/output proof failed");
  const input = yield* client.action(sandboxId, {
    op: "process.stdin.status",
    id: "terminal-live",
  });
  if (!input.closed || input.offset !== 0 || input.total !== 0)
    return yield* Effect.die("Terminal EOF did not remain retained");
  const foreground = yield* client.action(sandboxId, {
    op: "process.run",
    id: "terminal-foreground",
    language: "wasm",
    source: foregroundSource,
  });
  if (
    foreground.status !== "exited" ||
    foreground.output?.exitCode !== 0 ||
    foreground.output.stdout !== "interrupt\npair-done\n" ||
    foreground.output.stderr !== ""
  )
    return yield* Effect.die("Foreground alias and terminal-key signal proof failed");
  const written = yield* client.action(sandboxId, {
    op: "filesystem.writeFiles",
    entries: Object.entries(owners.children).map(([mode, content]) => ({
      path: `/tmp/raw-${mode}.wasm`,
      content,
      encoding: "base64" as const,
    })),
  });
  if (written.some((entry) => !entry.success))
    return yield* Effect.die("Raw owner fixtures were not installed");
  yield* Effect.forEach(Struct.keys(owners.children), (mode) =>
    client.action(sandboxId, { op: "filesystem.chmod", path: `/tmp/raw-${mode}.wasm`, mode: 493 }),
  );
  const rawOwners = yield* client.action(sandboxId, {
    op: "process.run",
    id: "terminal-raw-owners",
    language: "wasm",
    source: owners.parent,
  });
  if (
    rawOwners.status !== "exited" ||
    rawOwners.output?.exitCode !== 0 ||
    rawOwners.output.stdout !== "raw-owners-restored\n" ||
    rawOwners.output.stderr !== ""
  )
    return yield* Effect.die("Raw owner exit/exec recovery proof failed");
  return {
    initial,
    resized,
    terminal,
    agent,
    input,
    staleRevision: stale.failure.status,
    foreignSandbox: foreign.failure.status,
    foreground,
    rawOwners,
  } as const;
});
