import { Effect } from "effect";
import type { makeBinding } from "../../src/sdk";
import { descriptorCases } from "./descriptor-proof";

export const prepareDescriptorProof = Effect.fn("fixtures.prepareDescriptorProof")(function* (
  client: Effect.Success<ReturnType<typeof makeBinding>>,
  sandboxId: string,
) {
  const entries = yield* Effect.forEach(descriptorCases, (probe) =>
    Effect.gen(function* () {
      const bytes = yield* Effect.promise(() =>
        Bun.file(`dist/wasi-exec-${probe.mode}.wasm`).arrayBuffer(),
      );
      return {
        path: `/tmp/driver-${probe.mode}.wasm`,
        content: Buffer.from(bytes).toString("base64"),
        encoding: "base64" as const,
      };
    }),
  );
  const result = yield* client.action(sandboxId, { op: "filesystem.writeFiles", entries });
  if (
    result.length !== entries.length ||
    result.some((entry, index) => !entry.success || entry.path !== entries[index]?.path)
  )
    return yield* Effect.die(result);
});
