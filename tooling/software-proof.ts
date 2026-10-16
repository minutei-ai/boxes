import { downloadPublished } from "../tests/fixtures/published-package";
import { Clock, Config, Crypto, Effect, Redacted, Schema } from "effect";
import { BunCrypto } from "@effect/platform-bun";
import { FetchHttpClient } from "effect/http";
import { make } from "../dist/sdk/sdk.js";
import { Id, PackagePreparation, RunRecord } from "../src/contracts";
import {
  publishedPackages,
  publishedShellCases,
  publishedInterpreterFile,
  publishedInterpreterCases,
} from "../tests/fixtures/published-software";

const Report = Schema.Struct({
  target: Schema.String,
  measuredAt: Schema.Int,
  sandboxId: Id,
  reclaimed: Schema.Literal(true),
  packages: Schema.Array(PackagePreparation.fields.installed),
  runs: Schema.Array(RunRecord),
});
const report = await Effect.runPromise(
  Effect.scoped(
    Effect.gen(function* () {
      const url = yield* Config.String("CIRRO_URL");
      const token = yield* Config.Redacted("CIRRO_API_KEY");
      const cryptoService = yield* Crypto.Crypto;
      const id = `software-proof-${yield* cryptoService.randomUUIDv4()}`;
      const admin = yield* make({ url, token });
      yield* admin.create({
        id,
        policy: {
          interruptBudget: 100000,
          memoryBytes: 8388608,
          maxOutputBytes: 1048576,
          networkHosts: [],
        },
      });
      const grant = yield* admin.mintCapability(id, {
        permissions: ["read", "write", "execute", "manage"],
        expiresInSeconds: 3600,
      });
      const client = yield* Effect.acquireRelease(
        make({ url, token: Redacted.make(grant.token) }),
        (client) =>
          Effect.gen(function* () {
            yield* client.action(id, { op: "vm.dispose" });
            const collected = yield* client
              .action(id, { op: "vm.reclaim", limit: 1000 })
              .pipe(
                Effect.repeat({ until: (progress) => progress.status !== "pending", times: 7 }),
              );
            if (collected.status !== "complete") return yield* Effect.die(collected);
          }).pipe(Effect.orDie),
      );
      const packages = yield* Effect.forEach(publishedPackages, (software) =>
        Effect.gen(function* () {
          const bytes = yield* downloadPublished(software);
          const path = `/tmp/${software.name}.aospkg`;
          yield* client.action(id, {
            op: "filesystem.writeFile",
            path,
            content: Buffer.from(bytes).toString("base64"),
            encoding: "base64",
          });
          const installed = yield* client.action(id, {
            op: "software.install",
            source: { path, digest: `sha256:${software.digest}` },
          });
          if (installed.digest !== `sha256:${software.digest}`)
            return yield* Effect.die("Installed package digest mismatch");
          return installed;
        }),
      );
      yield* client.action(id, { op: "filesystem.writeFile", ...publishedInterpreterFile });
      yield* client.action(id, {
        op: "filesystem.chmod",
        path: publishedInterpreterFile.path,
        mode: 493,
      });
      const interpreted = yield* Effect.forEach(publishedInterpreterCases, (probe) =>
        Effect.gen(function* () {
          const run = yield* client.action(id, {
            op: "process.execFile",
            id: probe.id,
            command: probe.command,
            args: probe.args,
            env: { CIRRO_MARKER: probe.id },
            stdin: { content: "input line\n", encoding: "utf8" },
          });
          if (
            run.status !== "exited" ||
            run.output?.exitCode !== 0 ||
            run.output.stdout !== probe.stdout ||
            run.output.stderr !== ""
          )
            return yield* Effect.die({ probe, run });
          const file = yield* client.action(id, {
            op: "filesystem.readFile",
            path: "/tmp/from-script",
          });
          if (Buffer.from(file.content, file.encoding).toString("utf8") !== probe.id)
            return yield* Effect.die("Interpreter file effect was not retained");
          return run;
        }),
      );
      yield* client.action(id, {
        op: "filesystem.writeFile",
        path: "/tmp/input.json",
        content: '{"value":73}',
        encoding: "utf8",
      });
      const jq = yield* Effect.forEach(
        [
          { args: ["--version"], stdin: "", expected: "jq-jaq-0.1.0\n" },
          { args: [".value"], stdin: '{"value":42}', expected: "42\n" },
          { args: ["-n", "[range(0;10)] | add"], stdin: "", expected: "45\n" },
          { args: [".value", "/tmp/input.json"], stdin: "", expected: "73\n" },
        ],
        (probe, index) =>
          Effect.gen(function* () {
            const run = yield* client.action(id, {
              op: "process.execFile",
              id: `jq-${index}`,
              command: "jq",
              args: probe.args,
              stdin: { content: probe.stdin, encoding: "utf8" },
            });
            if (
              run.status !== "exited" ||
              run.output?.exitCode !== 0 ||
              run.output.stdout !== probe.expected ||
              run.output.stderr !== ""
            )
              return yield* Effect.die({ probe, run });
            return run;
          }),
      );
      const shell = yield* Effect.forEach(publishedShellCases, (probe, index) =>
        Effect.gen(function* () {
          const run = yield* client.action(id, {
            op: "process.execFile",
            id: `sh-${index}`,
            command: "sh",
            args: ["-c", probe.source],
            env: { PATH: "/opt/cirro/bin" },
          });
          if (
            run.status !== "exited" ||
            run.output?.exitCode !== 0 ||
            run.output.stdout !== probe.stdout ||
            run.output.stderr !== ""
          )
            return yield* Effect.die({ probe, run });
          return run;
        }),
      );
      const privateFile = yield* client.action(id, {
        op: "filesystem.stat",
        path: "/tmp/private",
        follow: true,
      });
      if ((privateFile.mode & 0o777) !== 0o600)
        return yield* Effect.die("Published sh did not apply its creation mask");
      const pipeline = yield* client.action(id, {
        op: "process.run",
        language: "shell",
        id: "pipeline",
        source: `echo '{"value":91}' | jq .value > /tmp/output; cat /tmp/output`,
      });
      if (
        pipeline.status !== "exited" ||
        pipeline.output?.exitCode !== 0 ||
        pipeline.output.stdout !== "91\n" ||
        pipeline.output.stderr !== ""
      )
        return yield* Effect.die({ pipeline });
      return {
        target: url,
        sandboxId: id,
        measuredAt: yield* Clock.currentTimeMillis,
        packages,
        runs: [...interpreted, ...jq, ...shell, pipeline],
      };
    }),
  ).pipe(
    Effect.map((proof) => ({ ...proof, reclaimed: true as const })),
    Effect.provide([FetchHttpClient.layer, BunCrypto.layer]),
  ),
);
console.log(Schema.encodeSync(Schema.fromJsonString(Report))(report));
