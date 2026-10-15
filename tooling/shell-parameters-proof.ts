import { Clock, Config, Crypto, Effect, Redacted, Schema } from "effect";
import { BunCrypto } from "@effect/platform-bun";
import { FetchHttpClient } from "effect/http";
import { make } from "../dist/sdk/sdk.js";

const Report = Schema.Struct({
  target: Schema.String,
  measuredAt: Schema.Int,
  checks: Schema.Array(Schema.Struct({ name: Schema.String, exitCode: Schema.Int })),
  disposal: Schema.Boolean,
});
const report = await Effect.runPromise(
  Effect.scoped(
    Effect.gen(function* () {
      const url = yield* Config.String("CIRRO_URL");
      const token = yield* Config.Redacted("CIRRO_API_KEY");
      const crypto = yield* Crypto.Crypto;
      const id = `shell-parameters-${yield* crypto.randomUUIDv4()}`;
      const measuredAt = yield* Clock.currentTimeMillis;
      const admin = yield* make({ url, token });
      yield* Effect.acquireRelease(
        admin.create({
          id,
          policy: {
            networkHosts: [],
            interruptBudget: 1000,
            memoryBytes: 8388608,
            maxOutputBytes: 1048576,
          },
          environment: { VALUE: "a  b", EMPTY: "", TARGET: "/tmp/with space" },
        }),
        () =>
          Effect.gen(function* () {
            const grant = yield* admin.mintCapability(id, {
              permissions: ["manage"],
              expiresInSeconds: 60,
            });
            const manager = yield* make({ url, token: Redacted.make(grant.token) });
            yield* manager.action(id, { op: "vm.dispose" });
          }).pipe(Effect.orDie),
      );
      const grant = yield* admin.mintCapability(id, {
        permissions: ["read", "write", "execute"],
        expiresInSeconds: 600,
      });
      const client = yield* make({ url, token: Redacted.make(grant.token) });
      const cases = [
        {
          name: "home-word",
          source: 'HOME="/tmp/home with space"; echo ~ ~/file',
          stdout: "/tmp/home with space /tmp/home with space/file\n",
          diagnostic: "",
          exitCode: 0,
        },
        {
          name: "home-quotes",
          source: String.raw`HOME=/tmp/home; echo '~' \~ ~'' ~/''file`,
          stdout: "~ ~ ~ /tmp/home/file\n",
          diagnostic: "",
          exitCode: 0,
        },
        {
          name: "home-assignment",
          source: 'HOME="/tmp/home with space"; A=~:~/bin:/bin:~; echo "$A"',
          stdout: "/tmp/home with space:/tmp/home with space/bin:/bin:/tmp/home with space\n",
          diagnostic: "",
          exitCode: 0,
        },
        {
          name: "home-declarations",
          source: 'HOME=/tmp/home; export A=~/export; readonly B=~/readonly; echo "$A:$B"',
          stdout: "/tmp/home/export:/tmp/home/readonly\n",
          diagnostic: "",
          exitCode: 0,
        },
        {
          name: "home-sequential",
          source: 'HOME=/tmp/old; HOME=/tmp/new A=~/file; echo "$A"',
          stdout: "/tmp/new/file\n",
          diagnostic: "",
          exitCode: 0,
        },
        {
          name: "home-temporary",
          source: "HOME=/tmp/old; HOME=/tmp/new echo ~; echo ~",
          stdout: "/tmp/old\n/tmp/old\n",
          diagnostic: "",
          exitCode: 0,
        },
        {
          name: "home-redirect",
          source:
            'HOME="/tmp/home with space"; mkdir -p "$HOME"; echo retained > ~/file; cat ~/file',
          stdout: "retained\n",
          diagnostic: "",
          exitCode: 0,
        },
        {
          name: "home-empty",
          source: 'HOME=""; echo before ~ after',
          stdout: "before  after\n",
          diagnostic: "",
          exitCode: 0,
        },
        {
          name: "home-missing",
          source: "unset HOME; A=~",
          stdout: "",
          diagnostic: "requires HOME",
          exitCode: 1,
        },
        {
          name: "home-login-denied",
          source: "HOME=/tmp/home; A=~root/file",
          stdout: "",
          diagnostic: "login-name tilde expansion",
          exitCode: 1,
        },
        {
          name: "readonly-value",
          source: 'readonly A="retained value"; echo "$A"',
          stdout: "retained value\n",
          diagnostic: "",
          exitCode: 0,
        },
        {
          name: "readonly-assignment",
          source: "readonly A=one; A=two; echo after",
          stdout: "",
          diagnostic: "readonly variable",
          exitCode: 2,
        },
        {
          name: "readonly-unset",
          source: "readonly A=one; unset A; echo after",
          stdout: "",
          diagnostic: "readonly variable",
          exitCode: 2,
        },
        {
          name: "readonly-export",
          source: "readonly A=one; export A=two; echo after",
          stdout: "",
          diagnostic: "readonly variable",
          exitCode: 2,
        },
        {
          name: "readonly-pipeline",
          source: 'readonly A=one | cat; A=two; echo "$A"',
          stdout: "two\n",
          diagnostic: "",
          exitCode: 0,
        },
        {
          name: "local-variable",
          source: 'A="local value"; echo "$A"',
          stdout: "local value\n",
          diagnostic: "",
          exitCode: 0,
        },
        {
          name: "temporary-prefix",
          source: 'A=old; A=new echo "$A"; echo "$A"',
          stdout: "old\nold\n",
          diagnostic: "",
          exitCode: 0,
        },
        {
          name: "sequential-prefix",
          source: 'A=one B=$A; echo "$A:$B"',
          stdout: "one:one\n",
          diagnostic: "",
          exitCode: 0,
        },
        {
          name: "special-prefix",
          source: 'A=new :; echo "$A"',
          stdout: "new\n",
          diagnostic: "",
          exitCode: 0,
        },
        {
          name: "export-word",
          source: 'export A=$VALUE; echo "$A"',
          stdout: "a  b\n",
          diagnostic: "",
          exitCode: 0,
        },
        {
          name: "unset-variable",
          source: 'export A=local; unset -v -- A; echo "[$A]"',
          stdout: "[]\n",
          diagnostic: "",
          exitCode: 0,
        },
        {
          name: "pipeline-variable",
          source: 'A=old; A=new | cat; echo "$A"',
          stdout: "old\n",
          diagnostic: "",
          exitCode: 0,
        },
        {
          name: "effective-home",
          source: "HOME=/tmp; cd; pwd",
          stdout: "/tmp\n",
          diagnostic: "",
          exitCode: 0,
        },
        { name: "quoted", source: 'echo "$VALUE"', stdout: "a  b\n", diagnostic: "", exitCode: 0 },
        {
          name: "split",
          source: "echo pre${VALUE}post",
          stdout: "prea bpost\n",
          diagnostic: "",
          exitCode: 0,
        },
        {
          name: "single-quoted",
          source: "echo '$VALUE'",
          stdout: "$VALUE\n",
          diagnostic: "",
          exitCode: 0,
        },
        {
          name: "escaped",
          source: String.raw`echo \$VALUE`,
          stdout: "$VALUE\n",
          diagnostic: "",
          exitCode: 0,
        },
        {
          name: "empty",
          source: 'echo before "$EMPTY" after',
          stdout: "before  after\n",
          diagnostic: "",
          exitCode: 0,
        },
        {
          name: "pipeline-status",
          source: 'false; true | echo "$?"',
          stdout: "1\n",
          diagnostic: "",
          exitCode: 0,
        },
        {
          name: "negated-status",
          source: "! true; echo $?",
          stdout: "1\n",
          diagnostic: "",
          exitCode: 0,
        },
        {
          name: "quoted-redirect",
          source: 'echo retained > "$TARGET"; cat "$TARGET"',
          stdout: "retained\n",
          diagnostic: "",
          exitCode: 0,
        },
      ];
      const checks = yield* Effect.forEach(cases, (probe) =>
        Effect.gen(function* () {
          const run = yield* client.action(id, {
            op: "process.run",
            id: probe.name,
            language: "shell",
            source: probe.source,
          });
          if (
            run.status !== "exited" ||
            run.output?.stdout !== probe.stdout ||
            (probe.diagnostic === "" && run.output.stderr !== "") ||
            (probe.diagnostic !== "" && !run.output.stderr.includes(probe.diagnostic)) ||
            run.output.exitCode !== probe.exitCode
          )
            return yield* Effect.die({ probe: probe.name, run });
          return { name: probe.name, exitCode: run.output.exitCode };
        }),
      );
      const ambiguous = yield* client.action(id, {
        op: "process.run",
        id: "ambiguous",
        language: "shell",
        source: "echo blocked 2> /tmp/errors > /tmp/earlier > $TARGET; cat /tmp/errors",
      });
      const earlier = yield* client.action(id, {
        op: "filesystem.stat",
        path: "/tmp/earlier",
        follow: true,
      });
      if (
        ambiguous.output?.stderr !== "" ||
        !ambiguous.output?.stdout.includes("Ambiguous shell redirection") ||
        earlier.size !== 0 ||
        ambiguous.output.exitCode !== 0
      )
        return yield* Effect.die("Ordered expanded redirection proof failed");
      checks.push({ name: "ordered-ambiguous-redirect", exitCode: ambiguous.output.exitCode });
      const injection = yield* client.action(id, {
        op: "process.run",
        id: "injection",
        language: "shell",
        source: 'echo "$VALUE"',
        env: { VALUE: "; touch /tmp/injected; echo unsafe" },
      });
      const absent = yield* client.action(id, { op: "filesystem.exists", path: "/tmp/injected" });
      if (
        injection.output?.stdout !== "; touch /tmp/injected; echo unsafe\n" ||
        absent.exists ||
        injection.output.exitCode !== 0
      )
        return yield* Effect.die("Expanded text was interpreted as shell syntax");
      checks.push({ name: "no-reparse", exitCode: injection.output.exitCode });
      const retained = yield* client.action(id, { op: "config.get" });
      if (
        retained.environment.VALUE !== "a  b" ||
        retained.environment.EMPTY !== "" ||
        retained.environment.TARGET !== "/tmp/with space" ||
        Object.keys(retained.environment).length !== 3
      )
        return yield* Effect.die("Shell variables changed sandbox configuration");
      checks.push({ name: "configuration-isolation", exitCode: 0 });
      return { target: url, measuredAt, checks, disposal: true };
    }),
  ).pipe(Effect.provide([FetchHttpClient.layer, BunCrypto.layer])),
);
console.log(await Effect.runPromise(Schema.encodeEffect(Schema.fromJsonString(Report))(report)));
