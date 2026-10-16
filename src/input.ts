import { Clock, Effect, Schema } from "effect";
import {
  Capability,
  Fault,
  InputHead,
  ProcessInputAction,
  StoredRun,
  TerminalGeometryAction,
  TerminalAttributesAction,
  TerminalConfigureAction,
  TerminalAttributeState,
  initialTerminalControl,
} from "./contracts";
import { requirePermission } from "./auth";
import { head, StorageFailure } from "./storage";
import { restore } from "./code";
import type { Env } from "./resources";

const load = Effect.fn("input.load")(function* (env: Env, sandboxId: string, id: string) {
  const object = yield* Effect.tryPromise({
    try: () => env.OBJECTS.get(`process-input/${sandboxId}/${id}.json`),
    catch: (cause) => new StorageFailure({ cause }),
  });
  if (object === null)
    return yield* new StorageFailure({ cause: "Missing interactive input head" });
  if (object.size > 131_072) return yield* new StorageFailure({ cause: "Oversized input head" });
  const text = yield* Effect.tryPromise({
    try: () => object.text(),
    catch: (cause) => new StorageFailure({ cause }),
  });
  const input = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(InputHead))(text);
  if (input.chunks.reduce((size, chunk) => size + chunk.size, 0) !== input.size)
    return yield* new StorageFailure({ cause: "Input chunk sizes do not match its head" });
  if ((input.terminal === null) !== (input.attributes === null))
    return yield* new StorageFailure({ cause: "Input terminal metadata does not match its mode" });
  if (input.attributes !== null) {
    const control = input.attributes;
    if (
      control.observed > control.requested ||
      (control.observed > 0 && control.snapshot === null) ||
      (control.snapshot !== null && control.snapshot.revision > control.desired.revision) ||
      (control.desired.attributes === null) !== (control.desired.revision === 0) ||
      (control.settled && control.observed !== control.requested)
    )
      return yield* new StorageFailure({ cause: "Invalid terminal attribute control state" });
  }
  return { input, etag: object.etag };
});

export const initializeInput = Effect.fn("input.initialize")(function* (
  env: Env,
  sandboxId: string,
  id: string,
  initial: Uint8Array,
  mode: Exclude<typeof StoredRun.Type.inputMode, "closed">,
) {
  const current = yield* Effect.tryPromise({
    try: () => env.OBJECTS.head(`process-input/${sandboxId}/${id}.json`),
    catch: (cause) => new StorageFailure({ cause }),
  });
  if (current !== null) return;
  if (initial.byteLength > 1_048_576)
    return yield* new StorageFailure({ cause: "Oversized initial stdin" });
  const chunks: (typeof InputHead.Type.chunks)[number][] = [];
  for (const offset of Array.from(
    { length: Math.ceil(initial.byteLength / 65_536) },
    (_, index) => index * 65_536,
  )) {
    const bytes = initial.subarray(offset, offset + 65_536);
    const digest = yield* Effect.promise(() =>
      crypto.subtle.digest("SHA-256", Uint8Array.from(bytes)),
    );
    const hash = Buffer.from(digest).toString("hex");
    yield* Effect.tryPromise({
      try: () =>
        env.OBJECTS.put(`sandboxes/${sandboxId}/stdin/${hash}`, bytes, {
          onlyIf: { etagDoesNotMatch: "*" },
        }),
      catch: (cause) => new StorageFailure({ cause }),
    });
    chunks.push({ hash, size: bytes.byteLength });
  }
  const metadata = yield* Effect.sync(() => {
    if (mode === "pty")
      return {
        terminal: { cols: 80, rows: 24, revision: 0 },
        attributes: initialTerminalControl,
      };
    return { terminal: null, attributes: null };
  });
  yield* Effect.tryPromise({
    try: () =>
      env.OBJECTS.put(
        `process-input/${sandboxId}/${id}.json`,
        Schema.encodeSync(Schema.fromJsonString(InputHead))({
          version: 3,
          ...metadata,
          size: initial.byteLength,
          closed: false,
          chunks,
        }),
        { onlyIf: { etagDoesNotMatch: "*" } },
      ),
    catch: (cause) => new StorageFailure({ cause }),
  });
});

export const finishInput = Effect.fn("input.finish")(function* (
  env: Env,
  sandboxId: string,
  id: string,
) {
  for (const attempt of [0, 1, 2]) {
    const { input, etag } = yield* load(env, sandboxId, id);
    if (input.closed) return;
    const saved = yield* Effect.tryPromise({
      try: () =>
        env.OBJECTS.put(
          `process-input/${sandboxId}/${id}.json`,
          Schema.encodeSync(Schema.fromJsonString(InputHead))({ ...input, closed: true }),
          { onlyIf: { etagMatches: etag } },
        ),
      catch: (cause) => new StorageFailure({ cause }),
    });
    if (saved !== null) return;
    if (attempt === 2)
      return yield* new StorageFailure({
        cause: "Input closure conflicted with concurrent writers",
      });
  }
});

export const readInput = Effect.fn("input.read")(function* (
  env: Env,
  sandboxId: string,
  id: string,
  offset: number,
  length: number,
) {
  const current = yield* load(env, sandboxId, id);
  const input = current.input;
  if (offset < 0 || offset > input.size || length < 0 || length > 65_536)
    return yield* new StorageFailure({ cause: "Invalid stdin read range" });
  const end = Math.min(offset + length, input.size);
  const data: Buffer[] = [];
  const position = { offset: 0 };
  for (const chunk of input.chunks) {
    const start = position.offset;
    position.offset += chunk.size;
    if (start >= end) break;
    if (position.offset <= offset) continue;
    const object = yield* Effect.tryPromise({
      try: () => env.OBJECTS.get(`sandboxes/${sandboxId}/stdin/${chunk.hash}`),
      catch: (cause) => new StorageFailure({ cause }),
    });
    if (object === null || object.size !== chunk.size)
      return yield* new StorageFailure({ cause: "Missing or invalid stdin block" });
    const bytes = yield* Effect.tryPromise({
      try: () => object.arrayBuffer(),
      catch: (cause) => new StorageFailure({ cause }),
    });
    const digest = yield* Effect.promise(() => crypto.subtle.digest("SHA-256", bytes));
    if (Buffer.from(digest).toString("hex") !== chunk.hash)
      return yield* new StorageFailure({ cause: "Stdin block digest mismatch" });
    data.push(
      Buffer.from(bytes).subarray(Math.max(offset - start, 0), Math.min(end - start, chunk.size)),
    );
  }
  return {
    data: Buffer.concat(data),
    head: current,
  };
});

const openInput = Effect.fn("input.open")(function* (
  env: Env,
  capability: typeof Capability.Type,
  id: string,
) {
  yield* head(env, capability.sandboxId);
  const process = yield* Effect.tryPromise({
    try: () => env.OBJECTS.get(`processes/${capability.sandboxId}/${id}.json`),
    catch: (cause) => new StorageFailure({ cause }),
  });
  if (process === null)
    return yield* new Fault({ code: "ENOENT", status: 404, message: "Execution does not exist" });
  if (process.size > 8_388_608)
    return yield* new StorageFailure({ cause: "Oversized process receipt" });
  const text = yield* Effect.tryPromise({
    try: () => process.text(),
    catch: (cause) => new StorageFailure({ cause }),
  });
  const record = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(StoredRun))(text);
  if (record.inputMode === "closed")
    return yield* new Fault({
      code: "EINVAL",
      status: 400,
      message: "Process stdin is not interactive",
    });
  const object = yield* Effect.tryPromise({
    try: () => env.OBJECTS.head(`process-input/${capability.sandboxId}/${id}.json`),
    catch: (cause) => new StorageFailure({ cause }),
  });
  if (object === null) {
    yield* requirePermission(capability, "execute");
    const program = yield* restore(env, capability.sandboxId, record.sourceHash);
    if (program.language !== "wasm")
      return yield* new StorageFailure({ cause: "Interactive process has a different runtime" });
    yield* initializeInput(
      env,
      capability.sandboxId,
      id,
      Buffer.from(program.stdin, "base64"),
      record.inputMode,
    );
  }
  return { record, ...(yield* load(env, capability.sandboxId, id)) };
});

export const input = Effect.fn("process.input")(function* (
  env: Env,
  capability: typeof Capability.Type,
  action: typeof ProcessInputAction.Type,
) {
  yield* requirePermission(capability, "execute");
  const { record, input: current, etag } = yield* openInput(env, capability, action.id);
  const closed = current.closed || (record.status !== "queued" && record.status !== "running");
  if (action.op === "process.stdin.status")
    return { offset: current.size, total: current.size, closed };
  const bytes = yield* Effect.sync(() => {
    if (action.op === "process.stdin.write") return Buffer.from(action.content, action.encoding);
    return Buffer.alloc(0);
  });
  if (
    action.op === "process.stdin.write" &&
    (bytes.length < 1 ||
      bytes.length > 65_536 ||
      (action.encoding === "base64" && bytes.toString("base64") !== action.content))
  )
    return yield* new Fault({
      code: "EINVAL",
      status: 400,
      message: "Stdin writes require 1 to 65536 bytes and canonical encoding",
    });
  if (
    action.op === "process.stdin.write" &&
    action.offset < current.size &&
    action.offset + bytes.length <= current.size
  ) {
    const previous = yield* readInput(
      env,
      capability.sandboxId,
      action.id,
      action.offset,
      bytes.length,
    );
    if (previous.data.equals(bytes))
      return { offset: action.offset + bytes.length, total: current.size, closed };
  }
  if (action.offset !== current.size)
    return yield* new Fault({
      code: "CONFLICT",
      status: 409,
      message: "Stdin offset changed; inspect process.stdin.status",
    });
  if (closed) {
    if (action.op === "process.stdin.close")
      return { offset: current.size, total: current.size, closed: true };
    return yield* new Fault({ code: "EPIPE", status: 409, message: "Process stdin is closed" });
  }
  if (
    current.size + bytes.length > 16_777_216 ||
    (current.chunks.length >= 1024 && bytes.length > 0)
  )
    return yield* new Fault({
      code: "EFBIG",
      status: 413,
      message: "Interactive stdin exceeds its byte or chunk limit",
    });
  const updated = yield* Effect.gen(function* () {
    if (action.op === "process.stdin.close") return { ...current, closed: true };
    const digest = yield* Effect.promise(() =>
      crypto.subtle.digest("SHA-256", Uint8Array.from(bytes)),
    );
    const hash = Buffer.from(digest).toString("hex");
    yield* Effect.tryPromise({
      try: () =>
        env.OBJECTS.put(`sandboxes/${capability.sandboxId}/stdin/${hash}`, bytes, {
          onlyIf: { etagDoesNotMatch: "*" },
        }),
      catch: (cause) => new StorageFailure({ cause }),
    });
    return {
      ...current,
      size: current.size + bytes.length,
      chunks: [...current.chunks, { hash, size: bytes.length }],
    };
  });
  const now = yield* Clock.currentTimeMillis;
  if (capability.expiresAt <= now)
    return yield* new Fault({ code: "UNAUTHORIZED", status: 401, message: "Capability expired" });
  yield* head(env, capability.sandboxId);
  const saved = yield* Effect.tryPromise({
    try: () =>
      env.OBJECTS.put(
        `process-input/${capability.sandboxId}/${action.id}.json`,
        Schema.encodeSync(Schema.fromJsonString(InputHead))(updated),
        { onlyIf: { etagMatches: etag } },
      ),
    catch: (cause) => new StorageFailure({ cause }),
  });
  if (saved === null)
    return yield* new Fault({
      code: "CONFLICT",
      status: 409,
      message: "Concurrent stdin mutation; inspect process.stdin.status",
    });
  return { offset: updated.size, total: updated.size, closed: updated.closed };
});

export const terminal = Effect.fn("process.terminal")(function* (
  env: Env,
  capability: typeof Capability.Type,
  action: typeof TerminalGeometryAction.Type,
) {
  if (action.op === "process.terminal.status") yield* requirePermission(capability, "read");
  else yield* requirePermission(capability, "execute");
  const { record, input: current, etag } = yield* openInput(env, capability, action.id);
  if (record.inputMode !== "pty")
    return yield* new Fault({ code: "EINVAL", status: 400, message: "Process has no terminal" });
  if (current.terminal === null)
    return yield* new StorageFailure({ cause: "PTY input head has no geometry" });
  if (current.attributes === null)
    return yield* new StorageFailure({ cause: "PTY input head has no attributes" });
  if (action.op === "process.terminal.status") return current.terminal;
  if (current.attributes.settled || (record.status !== "queued" && record.status !== "running"))
    return yield* new Fault({
      code: "EPIPE",
      status: 409,
      message: "Process terminal has settled",
    });
  if (action.revision !== current.terminal.revision)
    return yield* new Fault({
      code: "CONFLICT",
      status: 409,
      message: "Terminal revision changed; inspect process.terminal.status",
    });
  if (action.cols === current.terminal.cols && action.rows === current.terminal.rows)
    return current.terminal;
  if (current.terminal.revision === 4294967295)
    return yield* new Fault({
      code: "EFBIG",
      status: 409,
      message: "Terminal revision limit exceeded",
    });
  const geometry = {
    cols: action.cols,
    rows: action.rows,
    revision: current.terminal.revision + 1,
  };
  const now = yield* Clock.currentTimeMillis;
  if (capability.expiresAt <= now)
    return yield* new Fault({ code: "UNAUTHORIZED", status: 401, message: "Capability expired" });
  yield* head(env, capability.sandboxId);
  const saved = yield* Effect.tryPromise({
    try: () =>
      env.OBJECTS.put(
        `process-input/${capability.sandboxId}/${action.id}.json`,
        Schema.encodeSync(Schema.fromJsonString(InputHead))({ ...current, terminal: geometry }),
        { onlyIf: { etagMatches: etag } },
      ),
    catch: (cause) => new StorageFailure({ cause }),
  });
  if (saved === null)
    return yield* new Fault({
      code: "CONFLICT",
      status: 409,
      message: "Concurrent input or terminal mutation; inspect process.terminal.status",
    });
  return geometry;
});

export const observeTerminal = Effect.fn("input.observeTerminal")(function* (
  env: Env,
  sandboxId: string,
  id: string,
  current: Effect.Success<ReturnType<typeof load>>,
  snapshot: typeof TerminalAttributeState.Type,
  settled: boolean,
) {
  const { input, etag } = current;
  const control = input.attributes;
  if (control === null)
    return yield* new StorageFailure({ cause: "Input has no terminal attributes" });
  if (control.settled) return true;
  if (snapshot.revision !== control.desired.revision) return false;
  if (!settled && control.requested === control.observed) return true;
  const saved = yield* Effect.tryPromise({
    try: () =>
      env.OBJECTS.put(
        `process-input/${sandboxId}/${id}.json`,
        Schema.encodeSync(Schema.fromJsonString(InputHead))({
          ...input,
          closed: input.closed || settled,
          attributes: { ...control, snapshot, settled, observed: control.requested },
        }),
        { onlyIf: { etagMatches: etag } },
      ),
    catch: (cause) => new StorageFailure({ cause }),
  });
  return saved !== null;
});

export const configureTerminalAttributes = Effect.fn("process.configureTerminalAttributes")(
  function* (
    env: Env,
    capability: typeof Capability.Type,
    action: typeof TerminalConfigureAction.Type,
  ) {
    yield* requirePermission(capability, "execute");
    const { record, input: current, etag } = yield* openInput(env, capability, action.id);
    if (record.inputMode !== "pty")
      return yield* new Fault({ code: "EINVAL", status: 400, message: "Process has no terminal" });
    const control = current.attributes;
    if (control === null)
      return yield* new StorageFailure({ cause: "PTY input head has no attributes" });
    if (control.settled || (record.status !== "queued" && record.status !== "running"))
      return yield* new Fault({
        code: "EPIPE",
        status: 409,
        message: "Process terminal has settled",
      });
    if (action.revision !== control.desired.revision)
      return yield* new Fault({
        code: "CONFLICT",
        status: 409,
        message: "Terminal attribute revision changed; inspect process.terminal.attributes",
      });
    if (control.desired.revision === 4294967295)
      return yield* new Fault({
        code: "EFBIG",
        status: 409,
        message: "Terminal attribute revision limit exceeded",
      });
    const desired = { attributes: action.attributes, revision: control.desired.revision + 1 };
    const observedAt = yield* Clock.currentTimeMillis;
    if (capability.expiresAt <= observedAt)
      return yield* new Fault({ code: "UNAUTHORIZED", status: 401, message: "Capability expired" });
    yield* head(env, capability.sandboxId);
    const saved = yield* Effect.tryPromise({
      try: () =>
        env.OBJECTS.put(
          `process-input/${capability.sandboxId}/${action.id}.json`,
          Schema.encodeSync(Schema.fromJsonString(InputHead))({
            ...current,
            attributes: { ...control, desired },
          }),
          { onlyIf: { etagMatches: etag } },
        ),
      catch: (cause) => new StorageFailure({ cause }),
    });
    if (saved === null)
      return yield* new Fault({
        code: "CONFLICT",
        status: 409,
        message: "Concurrent input or terminal mutation; inspect terminal state",
      });
    return desired;
  },
);

export const terminalAttributes = Effect.fn("process.terminalAttributes")(function* (
  env: Env,
  capability: typeof Capability.Type,
  action: typeof TerminalAttributesAction.Type,
) {
  yield* requirePermission(capability, "read");
  const startedAt = yield* Clock.currentTimeMillis;
  const deadline = Math.min(capability.expiresAt, startedAt + action.timeoutMs);
  const request = { epoch: 0, delay: 16 };
  for (const attempt of Array.from({ length: 3 }, (_, index) => index)) {
    const now = yield* Clock.currentTimeMillis;
    if (capability.expiresAt <= now)
      return yield* new Fault({ code: "UNAUTHORIZED", status: 401, message: "Capability expired" });
    const { record, input: current, etag } = yield* openInput(env, capability, action.id);
    if (record.inputMode !== "pty")
      return yield* new Fault({ code: "EINVAL", status: 400, message: "Process has no terminal" });
    const control = current.attributes;
    if (control === null)
      return yield* new StorageFailure({ cause: "PTY input head has no attributes" });
    const observedAt = yield* Clock.currentTimeMillis;
    if (capability.expiresAt <= observedAt)
      return yield* new Fault({ code: "UNAUTHORIZED", status: 401, message: "Capability expired" });
    if (control.settled && control.snapshot !== null)
      return { desired: control.desired, observed: control.snapshot, settled: true };
    if (control.settled || (record.status !== "queued" && record.status !== "running"))
      return yield* new Fault({
        code: "EPIPE",
        status: 409,
        message: "Terminal has settled without a fresh attribute observation",
      });
    if (control.requested > control.observed) {
      request.epoch = control.requested;
      break;
    }
    if (control.requested === 4294967295)
      return yield* new Fault({
        code: "EFBIG",
        status: 409,
        message: "Terminal observation limit exceeded",
      });
    const requested = control.requested + 1;
    const saved = yield* Effect.tryPromise({
      try: () =>
        env.OBJECTS.put(
          `process-input/${capability.sandboxId}/${action.id}.json`,
          Schema.encodeSync(Schema.fromJsonString(InputHead))({
            ...current,
            attributes: { ...control, requested },
          }),
          { onlyIf: { etagMatches: etag } },
        ),
      catch: (cause) => new StorageFailure({ cause }),
    });
    if (saved !== null) {
      request.epoch = requested;
      break;
    }
    if (attempt === 2)
      return yield* new Fault({
        code: "CONFLICT",
        status: 409,
        message: "Concurrent terminal observation; retry the read",
      });
  }
  while (true) {
    const now = yield* Clock.currentTimeMillis;
    if (capability.expiresAt <= now)
      return yield* new Fault({ code: "UNAUTHORIZED", status: 401, message: "Capability expired" });
    const { record, input: current } = yield* openInput(env, capability, action.id);
    const observedAt = yield* Clock.currentTimeMillis;
    if (capability.expiresAt <= observedAt)
      return yield* new Fault({ code: "UNAUTHORIZED", status: 401, message: "Capability expired" });
    const control = current.attributes;
    if (control === null)
      return yield* new StorageFailure({ cause: "PTY input head has no attributes" });
    if (control.snapshot !== null && (control.settled || control.observed >= request.epoch))
      return { desired: control.desired, observed: control.snapshot, settled: control.settled };
    if (control.settled || (record.status !== "queued" && record.status !== "running"))
      return yield* new Fault({
        code: "EPIPE",
        status: 409,
        message: "No final terminal attributes were retained",
      });
    if (observedAt >= deadline)
      return yield* new Fault({
        code: "ETIMEDOUT",
        status: 408,
        message: "No fresh terminal attributes were observed before the deadline",
      });
    yield* Effect.sleep(Math.min(request.delay, deadline - observedAt));
    request.delay = Math.min(request.delay * 2, 1000);
  }
});
