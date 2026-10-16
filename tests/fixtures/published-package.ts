import { Effect } from "effect";
import { mkdir, mkdtemp, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readBounded } from "../../src/http";
import { publishedPackages } from "./published-software";

export const downloadPublished = Effect.fn("fixtures.downloadPublished")(function* (
  software: (typeof publishedPackages)[number],
) {
  const directory = join(tmpdir(), "boxes-published-software");
  const path = join(directory, `${software.digest}.aospkg`);
  const file = Bun.file(path);
  const cached = yield* Effect.promise(() => file.exists());
  const bytes = yield* Effect.gen(function* () {
    if (cached) {
      if (file.size !== software.size)
        return yield* Effect.die({ package: software.name, cached: true, bytes: file.size });
      return Buffer.from(yield* Effect.promise(() => file.arrayBuffer()));
    }
    const response = yield* Effect.tryPromise(() =>
      fetch(software.url, { signal: AbortSignal.timeout(30000) }),
    );
    if (response.status !== 200)
      return yield* Effect.die({ package: software.name, status: response.status });
    return yield* readBounded(response.body, software.size);
  });
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
  if (!cached)
    yield* Effect.scoped(
      Effect.gen(function* () {
        yield* Effect.promise(() => mkdir(directory, { recursive: true }));
        const temporary = yield* Effect.acquireRelease(
          Effect.promise(() => mkdtemp(join(directory, "download-"))),
          (path) => Effect.promise(() => rm(path, { recursive: true, force: true })),
        );
        const completed = join(temporary, "package.aospkg");
        yield* Effect.promise(() => Bun.write(completed, bytes));
        yield* Effect.promise(() => rename(completed, path));
      }),
    );
  return bytes;
});
