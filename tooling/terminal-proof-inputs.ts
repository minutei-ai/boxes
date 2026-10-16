import { Effect, Schema, Struct } from "effect";
import { TerminalProofInput } from "../tests/fixtures/terminal-proof";

export const terminalProofSources = Effect.fn("proof.terminalSources")(function* () {
  const loaded = yield* Effect.forEach(
    Struct.keys(TerminalProofInput.fields.rawOwners.fields.children.fields),
    (mode) =>
      Effect.gen(function* () {
        const bytes = yield* Effect.promise(() =>
          Bun.file(`dist/wasi-tty-raw-owner-${mode}.wasm`).arrayBuffer(),
        );
        return [mode, Buffer.from(bytes).toString("base64")] as const;
      }),
  );
  const parent = Buffer.from(
    yield* Effect.promise(() => Bun.file("dist/wasi-tty-raw-owner-parent.wasm").arrayBuffer()),
  ).toString("base64");
  const rawOwners = yield* Schema.decodeUnknownEffect(TerminalProofInput.fields.rawOwners)({
    parent,
    children: Object.fromEntries(loaded),
  });
  const source = Buffer.from(
    yield* Effect.promise(() => Bun.file("dist/wasi-pty-resize.wasm").arrayBuffer()),
  ).toString("base64");
  const foregroundSource = Buffer.from(
    yield* Effect.promise(() => Bun.file("dist/wasi-tty-foreground-pair.wasm").arrayBuffer()),
  ).toString("base64");
  const attributeSources = {
    pair: Buffer.from(
      yield* Effect.promise(() => Bun.file("dist/wasi-termios-pair.wasm").arrayBuffer()),
    ).toString("base64"),
    api: Buffer.from(
      yield* Effect.promise(() => Bun.file("dist/wasi-termios-api.wasm").arrayBuffer()),
    ).toString("base64"),
  };
  return { source, foregroundSource, rawOwners, attributeSources };
});
