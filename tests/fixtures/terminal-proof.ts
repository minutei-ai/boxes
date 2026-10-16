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
}));
export const TerminalProof = Schema.Struct({
  initial: TerminalGeometry,
  resized: TerminalGeometry,
  terminal: RunRecord,
  agent: RunRecord,
  input: InputReceipt,
  staleRevision: Schema.Literal(409),
  foreignSandbox: Schema.Literal(401),
});

export const terminalProof = Effect.fn("proof.terminal")(function* (
  client: Effect.Success<ReturnType<typeof make>>,
  sandboxId: typeof TerminalProofInput.Type.sandboxId,
  source: typeof TerminalProofInput.Type.source,
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
  return {
    initial,
    resized,
    terminal,
    agent,
    input,
    staleRevision: stale.failure.status,
    foreignSandbox: foreign.failure.status,
  } as const;
});
