import { Effect, Schedule, Schema, Struct } from "effect";
import type { make } from "../../src/sdk";
import {
  AgentRequest,
  InputReceipt,
  RunRecord,
  TerminalGeometry,
  TerminalAttributes,
  TerminalAttributeStatus,
  WasmProgram,
} from "../../src/contracts";

export const TerminalProofInput = AgentRequest.mapFields((fields) => ({
  ...Struct.pick(fields, ["sandboxId", "token"]),
  source: WasmProgram.fields.source,
  foregroundSource: WasmProgram.fields.source,
  attributeSources: Schema.Struct({
    pair: WasmProgram.fields.source,
    api: WasmProgram.fields.source,
  }),
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
  termios: RunRecord,
  attributes: Schema.Struct({
    initial: TerminalAttributeStatus,
    guest: TerminalAttributeStatus,
    final: TerminalAttributeStatus,
    process: RunRecord,
    staleRevision: Schema.Literal(409),
    foreignSandbox: Schema.Literal(401),
  }),
});

export const terminalProof = Effect.fn("proof.terminal")(function* (
  client: Effect.Success<ReturnType<typeof make>>,
  sandboxId: typeof TerminalProofInput.Type.sandboxId,
  source: typeof TerminalProofInput.Type.source,
  foregroundSource: typeof TerminalProofInput.Type.foregroundSource,
  owners: typeof TerminalProofInput.Type.rawOwners,
  attributeSources: typeof TerminalProofInput.Type.attributeSources,
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
  const termios = yield* client.action(sandboxId, {
    op: "process.run",
    id: "terminal-termios",
    language: "wasm",
    source: attributeSources.pair,
  });
  if (
    termios.status !== "exited" ||
    termios.output?.exitCode !== 0 ||
    termios.output.stdout !== "termios-verified\n" ||
    termios.output.stderr !== ""
  )
    return yield* Effect.die("Native terminal attribute ABI proof failed");
  yield* client.action(sandboxId, {
    op: "process.spawn",
    stdinMode: "pty",
    execution: {
      op: "process.run",
      id: "terminal-attributes",
      language: "wasm",
      source: attributeSources.api,
    },
  });
  const attributesPage = client.action(sandboxId, {
    op: "process.output.readLive",
    id: "terminal-attributes",
    after: null,
    maxBytes: 4096,
    maxEvents: 32,
  });
  const attributeMarker = Effect.fn("proof.terminal.attributeMarker")((marker: string) =>
    Effect.repeat(attributesPage, {
      until: (page) =>
        Effect.succeed(
          Buffer.concat(page.events.map((event) => Buffer.from(event.data, "base64"))).includes(
            Buffer.from(marker),
          ),
        ),
      schedule: Schedule.spaced("100 millis"),
    }).pipe(Effect.timeout("25 seconds")),
  );
  const observeAttributes = client.action(sandboxId, {
    op: "process.terminal.attributes",
    id: "terminal-attributes",
    timeoutMs: 25000,
  });
  yield* attributeMarker("attributes-ready\r\n");
  const initialAttributes = yield* observeAttributes;
  if (
    initialAttributes.desired.attributes !== null ||
    initialAttributes.desired.revision !== 0 ||
    initialAttributes.observed.revision !== 0 ||
    !initialAttributes.observed.attributes.icanon ||
    initialAttributes.settled
  )
    return yield* Effect.die("Unexpected initial native terminal attributes");
  const raw = Schema.decodeUnknownSync(TerminalAttributes)({
    icrnl: false,
    opost: false,
    onlcr: false,
    icanon: false,
    echo: false,
    isig: false,
    cc: [1, 2, 3, 4, 5, 6, 7],
  });
  const equivalent = Schema.toEquivalence(TerminalAttributes);
  const configured = yield* client.action(sandboxId, {
    op: "process.terminal.configure",
    id: "terminal-attributes",
    revision: 0,
    attributes: raw,
  });
  if (configured.revision !== 1 || !equivalent(configured.attributes, raw))
    return yield* Effect.die("Terminal desired attributes were not retained");
  const applied = yield* observeAttributes;
  if (applied.observed.revision !== 1 || !equivalent(applied.observed.attributes, raw))
    return yield* Effect.die("Terminal desired attributes were not applied");
  yield* client.action(sandboxId, {
    op: "process.stdin.write",
    id: "terminal-attributes",
    offset: 0,
    content: "X",
    encoding: "utf8",
  });
  yield* attributeMarker("guest-changed\n");
  const guestAttributes = yield* observeAttributes;
  if (
    guestAttributes.desired.revision !== 1 ||
    guestAttributes.desired.attributes === null ||
    !equivalent(guestAttributes.desired.attributes, raw) ||
    guestAttributes.observed.revision !== 1 ||
    !equivalent(guestAttributes.observed.attributes, { ...raw, echo: true })
  )
    return yield* Effect.die("Observation did not preserve independent guest attributes");
  const staleAttributes = yield* client
    .action(sandboxId, {
      op: "process.terminal.configure",
      id: "terminal-attributes",
      revision: 0,
      attributes: raw,
    })
    .pipe(Effect.result);
  if (
    staleAttributes._tag !== "Failure" ||
    staleAttributes.failure._tag !== "BoxesError" ||
    staleAttributes.failure.status !== 409
  )
    return yield* Effect.die("Stale terminal attribute configuration was not rejected");
  const foreignAttributes = yield* client
    .action(`${sandboxId}-other`, {
      op: "process.terminal.attributes",
      id: "terminal-attributes",
      timeoutMs: 0,
    })
    .pipe(Effect.result);
  if (
    foreignAttributes._tag !== "Failure" ||
    foreignAttributes.failure._tag !== "BoxesError" ||
    foreignAttributes.failure.status !== 401
  )
    return yield* Effect.die("Foreign terminal attributes remained readable");
  yield* client.action(sandboxId, {
    op: "process.terminal.configure",
    id: "terminal-attributes",
    revision: 1,
    attributes: raw,
  });
  const reapplied = yield* observeAttributes;
  if (reapplied.observed.revision !== 2 || !equivalent(reapplied.observed.attributes, raw))
    return yield* Effect.die("Explicit terminal reconfiguration did not supersede guest changes");
  yield* client.action(sandboxId, {
    op: "process.stdin.write",
    id: "terminal-attributes",
    offset: 1,
    content: "Y",
    encoding: "utf8",
  });
  yield* client.action(sandboxId, {
    op: "process.stdin.close",
    id: "terminal-attributes",
    offset: 2,
  });
  yield* attributeMarker("eof-ready\n");
  const cooked = { ...raw, icrnl: true, opost: true, onlcr: true, icanon: true, isig: true };
  yield* client.action(sandboxId, {
    op: "process.terminal.configure",
    id: "terminal-attributes",
    revision: 2,
    attributes: cooked,
  });
  const attributesProcess = yield* client.action(sandboxId, {
    op: "process.wait",
    id: "terminal-attributes",
    timeoutMs: 25000,
  });
  if (
    attributesProcess.status !== "exited" ||
    attributesProcess.output?.exitCode !== 0 ||
    attributesProcess.output.stdout !==
      "attributes-ready\r\nraw-ok\nguest-changed\nconfigured-again\neof-ready\nterminal-done\r\n" ||
    attributesProcess.output.stderr !== ""
  )
    return yield* Effect.die("Native terminal configuration after EOF failed");
  const finalAttributes = yield* observeAttributes;
  if (
    !finalAttributes.settled ||
    finalAttributes.desired.revision !== 3 ||
    finalAttributes.desired.attributes === null ||
    !equivalent(finalAttributes.desired.attributes, cooked) ||
    finalAttributes.observed.revision !== 3 ||
    !equivalent(finalAttributes.observed.attributes, cooked)
  )
    return yield* Effect.die("Final native terminal attributes were not retained");
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
    termios,
    attributes: {
      initial: initialAttributes,
      guest: guestAttributes,
      final: finalAttributes,
      process: attributesProcess,
      staleRevision: staleAttributes.failure.status,
      foreignSandbox: foreignAttributes.failure.status,
    },
  } as const;
});
