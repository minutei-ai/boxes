import { Clock, Effect, Schema, Schedule, Struct } from "effect";
import {
  AgentRequest,
  FileContent,
  RecoveryStatus,
  RunRecord,
  TerminalGeometry,
} from "../../src/contracts";
import type { makeBinding } from "../../src/sdk";

export const terminalBackends = ["minimal", "reedline"] as const;
export const TerminalBackend = Schema.Literals(terminalBackends);
export const PublishedTerminalInput = AgentRequest.mapFields((fields) => ({
  ...Struct.pick(fields, ["sandboxId", "token"]),
  backend: TerminalBackend,
}));
const TerminalObservation = Schema.Struct({
  operation: Schema.Literals(["read", "input.write"]),
  startedAt: Schema.Int,
  finishedAt: Schema.Int,
});
export const PublishedTerminalProof = Schema.Struct({
  backend: TerminalBackend,
  milliseconds: Schema.Int,
  recovery: RecoveryStatus,
  geometry: TerminalGeometry,
  record: RunRecord,
  file: FileContent,
  queries: Schema.Int,
  observations: Schema.Array(TerminalObservation),
});
export class TerminalObservationFailure extends Schema.TaggedError<TerminalObservationFailure>()(
  "TerminalObservationFailure",
  {
    marker: Schema.String,
    observed: Schema.String,
    queries: Schema.Int,
    record: RunRecord,
    observations: Schema.Array(TerminalObservation),
  },
) {}

export const publishedTerminalProof = Effect.fn("proof.software.terminal")(function* (
  client: Effect.Success<ReturnType<typeof makeBinding>>,
  id: string,
  backend: typeof TerminalBackend.Type,
) {
  const startedAt = yield* Clock.currentTimeMillis;
  const processId = `terminal-${backend}`;
  yield* Effect.logInfo({ phase: "software.terminal.start", sandboxId: id, processId });
  const filePath = `/tmp/once-${backend}`;
  yield* client.action(id, {
    op: "process.spawn",
    stdinMode: "pty",
    execution: {
      op: "process.execFile",
      id: processId,
      command: "sh",
      args: ["--input-backend", backend, "-i"],
      env: { TERM: "xterm-256color", PS1: "BOXES$ " },
    },
  });
  const first = yield* client.action(id, {
    op: "process.output.readLive",
    id: processId,
    after: null,
    maxBytes: 65536,
    maxEvents: 128,
  });
  const decoder = new TextDecoder();
  const observations: (typeof TerminalObservation.Type)[] = [];
  const input = { offset: 0 };
  const observed = {
    cursor: first.nextCursor,
    text: decoder.decode(
      Buffer.concat(
        first.events
          .filter((event) => event.stream === "stdout")
          .map((event) => Buffer.from(event.data, "base64")),
      ),
      { stream: true },
    ),
    queries: 0,
  };
  const writeInput = Effect.fn("proof.software.terminalInput")(function* (content: string) {
    const writeStartedAt = yield* Clock.currentTimeMillis;
    const receipt = yield* client.action(id, {
      op: "process.stdin.write",
      id: processId,
      offset: input.offset,
      content,
      encoding: "utf8",
    });
    observations.push({
      operation: "input.write",
      startedAt: writeStartedAt,
      finishedAt: yield* Clock.currentTimeMillis,
    });
    if (receipt.offset !== input.offset + Buffer.byteLength(content))
      return yield* Effect.die(receipt);
    input.offset = receipt.offset;
  });
  const readTerminal = Effect.fn("proof.software.terminalRead")(function* () {
    const readStartedAt = yield* Clock.currentTimeMillis;
    const page = yield* client.action(id, {
      op: "process.output.readLive",
      id: processId,
      after: observed.cursor,
      maxBytes: 65536,
      maxEvents: 128,
    });
    observations.push({
      operation: "read",
      startedAt: readStartedAt,
      finishedAt: yield* Clock.currentTimeMillis,
    });
    observed.cursor = page.nextCursor;
    observed.text += decoder.decode(
      Buffer.concat(
        page.events
          .filter((event) => event.stream === "stdout")
          .map((event) => Buffer.from(event.data, "base64")),
      ),
      { stream: true },
    );
    const queries = observed.text.match(/\x1b\[6n/g)?.length ?? 0;
    if (
      page.state !== "exited" &&
      page.state !== "failed" &&
      page.state !== "cancelled" &&
      queries > observed.queries
    ) {
      yield* writeInput("\x1b[1;1R".repeat(queries - observed.queries));
      observed.queries = queries;
    }
    return page;
  });
  const observe = Effect.fn("proof.software.terminalObserve")((marker: RegExp) =>
    readTerminal().pipe(
      Effect.repeat({
        until: () => marker.test(observed.text),
        schedule: Schedule.spaced("100 millis"),
      }),
      Effect.timeout("15 seconds"),
      Effect.catchTag("TimeoutError", () =>
        Effect.gen(function* () {
          const record = yield* client.action(id, { op: "process.get", id: processId });
          return yield* new TerminalObservationFailure({
            marker: marker.source,
            observed: observed.text,
            queries: observed.queries,
            record,
            observations,
          });
        }),
      ),
    ),
  );
  yield* observe(/BOXES\$ /);
  yield* writeInput(`printf '\\nRUN\\n'; printf once >> ${filePath}\r`);
  yield* observe(/\r?\nRUN\r?\n/);
  yield* writeInput("printf 'retained:%s\\n' kept");
  yield* observe(/kept/);
  yield* client.action(id, {
    op: "process.terminal.resize",
    id: processId,
    cols: 120,
    rows: 40,
    revision: 0,
  });
  const before = yield* client.action(id, { op: "process.recovery.status", id: processId });
  const prefix = observed.text;
  yield* Effect.logInfo({
    phase: "software.terminal.waitCheckpoint",
    sandboxId: id,
    processId,
    checkpoints: before.checkpoints,
  });
  const recovery = yield* Effect.gen(function* () {
    const page = yield* readTerminal();
    if (page.state === "exited" || page.state === "failed" || page.state === "cancelled")
      return yield* Effect.die({
        backend,
        page,
        record: yield* client.action(id, { op: "process.get", id: processId }),
      });
    return yield* client.action(id, { op: "process.recovery.status", id: processId });
  }).pipe(
    Effect.repeat({
      until: (state) => state.checkpoints > before.checkpoints,
      schedule: Schedule.spaced("250 millis"),
    }),
    Effect.timeout("70 seconds"),
  );
  yield* writeInput("\rprintf 'completed:%s\\n' kept; exit 7\r");
  yield* Effect.logInfo({
    phase: "software.terminal.resumed",
    sandboxId: id,
    processId,
    checkpoints: recovery.checkpoints,
  });
  yield* readTerminal().pipe(
    Effect.repeat({
      until: (page) =>
        page.state === "exited" || page.state === "failed" || page.state === "cancelled",
      schedule: Schedule.spaced("100 millis"),
    }),
    Effect.timeout("30 seconds"),
  );
  const record = yield* client.action(id, { op: "process.get", id: processId });
  if (
    record.status !== "exited" ||
    record.output?.exitCode !== 7 ||
    !record.output.stdout.startsWith(prefix) ||
    record.output.stdout.match(/\r?\nRUN\r?\n/g)?.length !== 1 ||
    !record.output.stdout.includes("retained:kept") ||
    !record.output.stdout.includes("completed:kept")
  )
    return yield* new TerminalObservationFailure({
      marker: "completed:kept and exit 7",
      observed: observed.text,
      queries: observed.queries,
      record,
      observations,
    });
  const file = yield* client.action(id, { op: "filesystem.readFile", path: filePath });
  if (Buffer.from(file.content, file.encoding).toString() !== "once")
    return yield* Effect.die({ backend, file });
  const geometry = yield* client.action(id, {
    op: "process.terminal.status",
    id: processId,
  });
  if (geometry.cols !== 120 || geometry.rows !== 40 || geometry.revision !== 1)
    return yield* Effect.die({ backend, geometry });
  return {
    backend,
    milliseconds: (yield* Clock.currentTimeMillis) - startedAt,
    recovery,
    geometry,
    record,
    file,
    queries: observed.queries,
    observations,
  };
}, Effect.timeout("110 seconds"));
