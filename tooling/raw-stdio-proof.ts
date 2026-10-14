import { Clock, Config, Crypto, Effect, Redacted, Schema } from "effect";
import { BunCrypto } from "@effect/platform-bun";
import { FetchHttpClient } from "effect/http";
import { make } from "../src/sdk";

const Report = Schema.Struct({
  target: Schema.String,
  measuredAt: Schema.Int,
  fixtureSha256: Schema.String,
  cases: Schema.Array(
    Schema.Struct({
      mode: Schema.String,
      exitCode: Schema.NullOr(Schema.Int),
      stdoutBytes: Schema.Int,
      stderrBytes: Schema.Int,
      pages: Schema.Int,
    }),
  ),
  disposal: Schema.Boolean,
});

const report = await Effect.runPromise(
  Effect.scoped(
    Effect.gen(function* () {
      const url = yield* Config.String("CIRRO_URL");
      const token = yield* Config.Redacted("CIRRO_API_KEY");
      const crypto = yield* Crypto.Crypto;
      const id = `raw-stdio-${yield* crypto.randomUUIDv4()}`;
      const measuredAt = yield* Clock.currentTimeMillis;
      const admin = yield* make({ url, token });
      yield* admin.create({
        id,
        policy: {
          networkHosts: [],
          interruptBudget: 1000,
          memoryBytes: 8388608,
          maxOutputBytes: 70009,
        },
      });
      const grant = yield* admin.mintCapability(id, {
        permissions: ["read", "execute", "manage"],
        expiresInSeconds: 600,
      });
      const client = yield* Effect.acquireRelease(
        make({ url, token: Redacted.make(grant.token) }),
        (client) => client.action(id, { op: "vm.dispose" }).pipe(Effect.orDie),
      );
      const fixture = Buffer.from(
        yield* Effect.promise(() => Bun.file("dist/wasi-raw-stdio.wasm").arrayBuffer()),
      );
      const fixtureSha256 = Buffer.from(yield* crypto.digest("SHA-256", fixture)).toString("hex");
      const expected = Buffer.from(Array.from({ length: 70003 }, (_, index) => index % 256));
      const expectedError = Buffer.from([255, 0, 128, 195, 40, 254]);
      const cases = yield* Effect.forEach(["success", "failure"], (mode) =>
        Effect.gen(function* () {
          const record = yield* client.action(id, {
            op: "process.run",
            id: mode,
            language: "wasm",
            source: fixture.toString("base64"),
            args: [mode],
          });
          if (record.status !== "exited") return yield* Effect.die("WASI did not exit");
          if (mode === "success" && record.output?.exitCode !== 0)
            return yield* Effect.die("Unexpected success exit code");
          if (mode === "failure" && record.output?.exitCode !== 7)
            return yield* Effect.die("Unexpected failure exit code");
          const pages = yield* Effect.forEach([null, 65536], (after) =>
            client.action(id, {
              op: "process.output.read",
              id: mode,
              after,
              maxBytes: 65536,
              maxEvents: 128,
            }),
          );
          const events = pages.flatMap((page) => page.events);
          const stdout = Buffer.concat(
            events
              .filter((event) => event.stream === "stdout")
              .map((event) => Buffer.from(event.data, "base64")),
          );
          const stderr = Buffer.concat(
            events
              .filter((event) => event.stream === "stderr")
              .map((event) => Buffer.from(event.data, "base64")),
          );
          if (!stdout.equals(expected) || !stderr.equals(expectedError))
            return yield* Effect.die("Raw output bytes differ");
          if (pages[1]?.hasMore !== false)
            return yield* Effect.die("Output pagination did not finish");
          return {
            mode,
            exitCode: record.output?.exitCode ?? null,
            stdoutBytes: stdout.length,
            stderrBytes: stderr.length,
            pages: pages.length,
          };
        }),
      );
      return { target: url, measuredAt, fixtureSha256, cases, disposal: true };
    }),
  ).pipe(Effect.provide([FetchHttpClient.layer, BunCrypto.layer])),
);
console.log(await Effect.runPromise(Schema.encodeEffect(Schema.fromJsonString(Report))(report)));
