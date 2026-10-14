import { Clock, Config, Crypto, Effect, Redacted, Schema } from "effect";
import { BunCrypto } from "@effect/platform-bun";
import { FetchHttpClient } from "effect/http";
import { make } from "../src/sdk";
import { FileContent } from "../src/contracts";

const Report = Schema.Struct({
  target: Schema.String,
  measuredAt: Schema.Int,
  lines: Schema.Int,
  words: Schema.Int,
  readonlyDenied: Schema.Boolean,
  disposal: Schema.Boolean,
});
const report = await Effect.runPromise(
  Effect.scoped(
    Effect.gen(function* () {
      const url = yield* Config.String("CIRRO_URL");
      const token = yield* Config.Redacted("CIRRO_API_KEY");
      const crypto = yield* Crypto.Crypto;
      const id = `guest-work-${yield* crypto.randomUUIDv4()}`;
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
      const run = yield* client.action(id, {
        op: "process.run",
        id: "work",
        language: "typescript",
        source:
          'export default async ({tools}) => { await tools.call({op:"filesystem.writeFile",path:"/tmp/work",content:"a\\nb\\n",encoding:"utf8"}); await tools.call({op:"process.run",id:"lines",language:"shell",source:"wc -l < /tmp/work > /tmp/count"}); return tools.call({op:"filesystem.readFile",path:"/tmp/count"}); }',
      });
      if (run.output?.exitCode !== 0) return yield* Effect.die("Guest shell failed");
      const file = yield* Schema.decodeUnknownEffect(FileContent)(run.output.result);
      if (Buffer.from(file.content, file.encoding).toString() !== "2\n")
        return yield* Effect.die("Guest shell result differs");
      const words = yield* client.action(id, {
        op: "process.run",
        id: "words",
        language: "shell",
        source: "echo 'a\u000bb' | wc -w",
      });
      if (words.output?.stdout !== "2\n")
        return yield* Effect.die("Vertical tab word boundary differs");
      const readonlyGrant = yield* admin.mintCapability(id, {
        permissions: ["read", "execute"],
        expiresInSeconds: 60,
      });
      const readonly = yield* make({ url, token: Redacted.make(readonlyGrant.token) });
      const denied = yield* readonly.action(id, {
        op: "process.run",
        id: "readonly",
        language: "typescript",
        source:
          'export default async ({tools}) => tools.call({op:"filesystem.writeFile",path:"/tmp/denied",content:"forbidden",encoding:"utf8"})',
      });
      const exists = yield* client.action(id, { op: "filesystem.exists", path: "/tmp/denied" });
      if (denied.output?.exitCode === 0 || exists.exists)
        return yield* Effect.die("Readonly guest changed files");
      return {
        target: url,
        measuredAt: yield* Clock.currentTimeMillis,
        lines: 2,
        words: 2,
        readonlyDenied: true,
        disposal: true,
      };
    }),
  ).pipe(Effect.provide([FetchHttpClient.layer, BunCrypto.layer])),
);
console.log(await Effect.runPromise(Schema.encodeEffect(Schema.fromJsonString(Report))(report)));
