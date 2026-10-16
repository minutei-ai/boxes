import { Effect } from "effect";
import { readBounded } from "../../src/http";
import { publishedPackages } from "./published-software";

export const downloadPublished = Effect.fn("fixtures.downloadPublished")(function* (
  software: (typeof publishedPackages)[number],
) {
  const response = yield* Effect.tryPromise(() =>
    fetch(
      `https://releases.rivet.dev/agent-os/latest/software/packages/${software.name}/${software.digest}.aospkg`,
      { signal: AbortSignal.timeout(30000) },
    ),
  );
  if (response.status !== 200)
    return yield* Effect.die({ package: software.name, status: response.status });
  const bytes = yield* readBounded(response.body, software.size);
  const digest = Buffer.from(
    yield* Effect.tryPromise(() => crypto.subtle.digest("SHA-256", bytes)),
  ).toString("hex");
  if (bytes.byteLength !== software.size || digest !== software.digest)
    return yield* Effect.die({
      package: software.name,
      expected: software.digest,
      actual: digest,
      bytes: bytes.byteLength,
    });
  return bytes;
});
