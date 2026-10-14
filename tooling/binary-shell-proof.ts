import { Clock, Config, Crypto, Effect, Redacted, Schema } from "effect";
import { BunCrypto } from "@effect/platform-bun";
import { FetchHttpClient } from "effect/http";
import { make } from "../src/sdk";
import { commandPackage } from "../tests/fixtures/package";

const Report = Schema.Struct({
  target: Schema.String,
  measuredAt: Schema.Int,
  checks: Schema.Array(
    Schema.Struct({ name: Schema.String, bytes: Schema.Int, exitCode: Schema.NullOr(Schema.Int) }),
  ),
  disposal: Schema.Boolean,
});
const report = await Effect.runPromise(
  Effect.scoped(
    Effect.gen(function* () {
      const url = yield* Config.String("CIRRO_URL");
      const token = yield* Config.Redacted("CIRRO_API_KEY");
      const crypto = yield* Crypto.Crypto;
      const id = `binary-shell-${yield* crypto.randomUUIDv4()}`;
      const measuredAt = yield* Clock.currentTimeMillis;
      const admin = yield* make({ url, token });
      yield* admin.create({
        id,
        policy: {
          networkHosts: [],
          interruptBudget: 1000,
          memoryBytes: 8388608,
          maxOutputBytes: 1048576,
        },
      });
      const grant = yield* admin.mintCapability(id, {
        permissions: ["read", "write", "execute", "manage"],
        expiresInSeconds: 600,
      });
      const client = yield* Effect.acquireRelease(
        make({ url, token: Redacted.make(grant.token) }),
        (client) => client.action(id, { op: "vm.dispose" }).pipe(Effect.orDie),
      );
      const binary = Buffer.from(
        yield* Effect.promise(() => Bun.file("dist/wasi-raw-stdio.wasm").arrayBuffer()),
      );
      const input = Buffer.from(Array.from({ length: 70003 }, (_, index) => index % 256));
      yield* client.action(id, {
        op: "filesystem.writeFile",
        path: "/tmp/input",
        content: input.toString("base64"),
        encoding: "base64",
      });
      yield* client.action(id, {
        op: "filesystem.writeFile",
        path: "/tmp/package",
        content: commandPackage(binary).toString("base64"),
        encoding: "base64",
      });
      yield* client.action(id, { op: "software.install", source: { path: "/tmp/package" } });
      const filterInput = Buffer.from([
        65, 255, 0, 13, 10, 98, 128, 10, 98, 128, 10, 195, 169, 32, 120,
      ]);
      yield* client.action(id, {
        op: "filesystem.writeFile",
        path: "/tmp/filter-input",
        content: filterInput.toString("base64"),
        encoding: "base64",
      });
      const cases = [
        {
          name: "pipe",
          source: "probe | cat > /tmp/pipe",
          path: "/tmp/pipe",
          bytes: input,
          exitCode: 0,
        },
        {
          name: "append",
          source:
            "cat /tmp/input | probe echo > /tmp/append; probe echo < /tmp/input >> /tmp/append",
          path: "/tmp/append",
          bytes: Buffer.concat([input, input]),
          exitCode: 0,
        },
        {
          name: "failure",
          source: "probe failure > /tmp/failure",
          path: "/tmp/failure",
          bytes: input,
          exitCode: 7,
        },
        {
          name: "trap",
          source: "probe trap > /tmp/trap",
          path: "/tmp/trap",
          bytes: input,
          exitCode: 126,
        },
        {
          name: "head-lines",
          source: "head -n 1 < /tmp/filter-input > /tmp/head",
          path: "/tmp/head",
          bytes: filterInput.subarray(0, 5),
          exitCode: 0,
        },
        {
          name: "tail-lines",
          source: "tail -n 1 < /tmp/filter-input > /tmp/tail",
          path: "/tmp/tail",
          bytes: filterInput.subarray(11),
          exitCode: 0,
        },
        {
          name: "head-bytes",
          source: "head -c 3 < /tmp/filter-input > /tmp/head-bytes",
          path: "/tmp/head-bytes",
          bytes: filterInput.subarray(0, 3),
          exitCode: 0,
        },
        {
          name: "tail-bytes",
          source: "tail -c 4 < /tmp/filter-input > /tmp/tail-bytes",
          path: "/tmp/tail-bytes",
          bytes: filterInput.subarray(11),
          exitCode: 0,
        },
        {
          name: "wc-bytes",
          source: "wc -c < /tmp/filter-input > /tmp/wc",
          path: "/tmp/wc",
          bytes: Buffer.from("15\n"),
          exitCode: 0,
        },
        {
          name: "sort",
          source: "sort < /tmp/filter-input > /tmp/sort",
          path: "/tmp/sort",
          bytes: Buffer.concat([filterInput, Buffer.from("\n")]),
          exitCode: 0,
        },
        {
          name: "uniq",
          source: "uniq < /tmp/filter-input > /tmp/uniq",
          path: "/tmp/uniq",
          bytes: Buffer.concat([
            filterInput.subarray(0, 8),
            filterInput.subarray(11),
            Buffer.from("\n"),
          ]),
          exitCode: 0,
        },
        {
          name: "grep",
          source: "grep '^A' < /tmp/filter-input > /tmp/grep",
          path: "/tmp/grep",
          bytes: filterInput.subarray(0, 5),
          exitCode: 0,
        },
      ];
      const checks = yield* Effect.forEach(cases, (item) =>
        Effect.gen(function* () {
          const record = yield* client.action(id, {
            op: "process.run",
            id: item.name,
            language: "shell",
            source: item.source,
          });
          if (record.output?.stdout !== "" || record.output.exitCode !== item.exitCode)
            return yield* Effect.die("Unexpected shell output or exit code");
          const file = yield* client.action(id, { op: "filesystem.readFile", path: item.path });
          const bytes = Buffer.from(file.content, file.encoding);
          if (!bytes.equals(item.bytes)) return yield* Effect.die("Shell file bytes differ");
          return { name: item.name, bytes: bytes.length, exitCode: record.output.exitCode };
        }),
      );
      return { target: url, measuredAt, checks, disposal: true };
    }),
  ).pipe(Effect.provide([FetchHttpClient.layer, BunCrypto.layer])),
);
console.log(await Effect.runPromise(Schema.encodeEffect(Schema.fromJsonString(Report))(report)));
