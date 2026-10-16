import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Clock, Effect, Redacted, Schema } from "effect";
import { FetchHttpClient } from "effect/http";
import { defaultSoftware } from "../src/default-software";
import { make, makeBinding } from "../src/sdk";
import { prepareSoftwareBase } from "./software-base";
import { runtime } from "./worker-test";

const Probe = Schema.Struct({
  id: Schema.String,
  command: Schema.String,
  args: Schema.Array(Schema.String),
  stdin: Schema.String,
  stdout: Schema.String,
  exitCode: Schema.Int,
});
const probes = Schema.decodeUnknownSync(Schema.Array(Probe))([
  {
    id: "coreutils",
    command: "printf",
    args: ["%s:%s\\n", "native", "image"],
    stdin: "",
    stdout: "native:image\n",
    exitCode: 0,
  },
  {
    id: "bracket",
    command: "[",
    args: ["42", "-eq", "42", "]"],
    stdin: "",
    stdout: "",
    exitCode: 0,
  },
  {
    id: "bracket-false",
    command: "[",
    args: ["42", "-eq", "43", "]"],
    stdin: "",
    stdout: "",
    exitCode: 1,
  },
  {
    id: "sed",
    command: "sed",
    args: ["s/old/new/g"],
    stdin: "old old\n",
    stdout: "new new\n",
    exitCode: 0,
  },
  {
    id: "grep",
    command: "grep",
    args: ["needle"],
    stdin: "hay\nneedle\n",
    stdout: "needle\n",
    exitCode: 0,
  },
  {
    id: "gawk",
    command: "awk",
    args: ["{ sum += $1 } END { print sum }"],
    stdin: "5\n7\n",
    stdout: "12\n",
    exitCode: 0,
  },
  {
    id: "findutils",
    command: "find",
    args: ["/tmp", "-name", "seed.txt"],
    stdin: "",
    stdout: "/tmp/seed.txt\n",
    exitCode: 0,
  },
  {
    id: "diffutils",
    command: "diff",
    args: ["/tmp/a", "/tmp/b"],
    stdin: "",
    stdout: "1c1\n< alpha\n---\n> beta\n",
    exitCode: 1,
  },
  {
    id: "tar-write",
    command: "tar",
    args: ["-cf", "/tmp/probe.tar", "-C", "/tmp", "seed.txt"],
    stdin: "",
    stdout: "",
    exitCode: 0,
  },
  {
    id: "tar-read",
    command: "tar",
    args: ["-tf", "/tmp/probe.tar"],
    stdin: "",
    stdout: "seed.txt\n",
    exitCode: 0,
  },
  {
    id: "gzip-write",
    command: "gzip",
    args: ["-k", "/tmp/compress"],
    stdin: "",
    stdout: "",
    exitCode: 0,
  },
  {
    id: "gzip-read",
    command: "gzip",
    args: ["-d", "-c", "/tmp/compress.gz"],
    stdin: "",
    stdout: "compressed content\n",
    exitCode: 0,
  },
  {
    id: "jq",
    command: "jq",
    args: [".value + 1"],
    stdin: '{"value":41}\n',
    stdout: "42\n",
    exitCode: 0,
  },
  {
    id: "sh",
    command: "sh",
    args: ["-c", "printf 'shell-ready\\n'"],
    stdin: "",
    stdout: "shell-ready\n",
    exitCode: 0,
  },
]);

const report = await Effect.runPromise(
  Effect.scoped(
    Effect.gen(function* () {
      const startedAt = yield* Clock.currentTimeMillis;
      const bytes = yield* Effect.promise(() =>
        Bun.file(new URL("../dist/kernel/cirro_kernel_bg.wasm", import.meta.url)).arrayBuffer(),
      );
      const base = yield* prepareSoftwareBase({
        kernelDigest: new Bun.CryptoHasher("sha256").update(bytes).digest("hex"),
        artifacts: defaultSoftware,
      });
      const directory = yield* Effect.acquireRelease(
        Effect.promise(() => mkdtemp(join(tmpdir(), "boxes-full-software-"))),
        (path) => Effect.promise(() => rm(path, { recursive: true, force: true })),
      );
      const worker = yield* Effect.acquireRelease(
        Effect.sync(() => runtime(directory, { softwareBase: base.digest, controlled: false })),
        (worker) => Effect.promise(() => worker.dispose()),
      );
      const objects = yield* Effect.promise(() => worker.objects);
      yield* Effect.forEach(
        base.blocks,
        ([hash, bytes]) => Effect.promise(() => objects.put(`software/blobs/${hash}`, bytes)),
        { concurrency: 1, discard: true },
      );
      yield* Effect.promise(() => objects.put(`software/bases/${base.digest}.json`, base.manifest));
      const admin = yield* make({
        url: (yield* Effect.promise(() => worker.ready)).toString(),
        token: Redacted.make("cirro-local-test-credential"),
      });
      yield* admin.create({
        id: "full-image",
        policy: {
          interruptBudget: 100000,
          memoryBytes: 33554432,
          maxOutputBytes: 1048576,
          networkHosts: [],
        },
      });
      const management = yield* admin.mintCapability("full-image", {
        permissions: ["manage"],
        expiresInSeconds: 3600,
      });
      const manager = yield* makeBinding(
        yield* Effect.promise(() => worker.service),
        Redacted.make(management.token),
      );
      yield* Effect.addFinalizer(() =>
        Effect.gen(function* () {
          yield* manager.action("full-image", { op: "vm.dispose" });
          const reclaimed = yield* manager
            .action("full-image", { op: "vm.reclaim", limit: 1000 })
            .pipe(Effect.repeat({ until: (progress) => progress.status !== "pending", times: 7 }));
          if (reclaimed.status !== "complete") return yield* Effect.die(reclaimed);
        }).pipe(Effect.orDie),
      );
      const grant = yield* admin.mintCapability("full-image", {
        permissions: ["read", "write", "execute"],
        expiresInSeconds: 3600,
      });
      const client = yield* makeBinding(
        yield* Effect.promise(() => worker.service),
        Redacted.make(grant.token),
      );
      const catalog = yield* client.action("full-image", { op: "software.list" });
      if (
        catalog.length !== defaultSoftware.length ||
        defaultSoftware.some(
          (artifact) => !catalog.some((installed) => installed.packageId === artifact.digest),
        )
      )
        return yield* Effect.die({ catalog });
      const privateBefore = yield* Effect.promise(() =>
        objects.list({ prefix: "sandboxes/full-image/blobs/" }),
      );
      if (privateBefore.objects.length !== 0) return yield* Effect.die(privateBefore);
      yield* Effect.forEach(
        [
          { path: "/tmp/seed.txt", content: "seed\n" },
          { path: "/tmp/a", content: "alpha\n" },
          { path: "/tmp/b", content: "beta\n" },
          { path: "/tmp/compress", content: "compressed content\n" },
        ],
        (file) =>
          client.action("full-image", { op: "filesystem.writeFile", ...file, encoding: "utf8" }),
        { concurrency: 1, discard: true },
      );
      const runs = yield* Effect.forEach(
        probes,
        Effect.fn("proof.defaultSoftware")(function* (probe) {
          yield* Effect.logInfo({ phase: "software.probe", id: probe.id });
          const result = yield* client.action("full-image", {
            op: "process.execFile",
            id: probe.id,
            command: `/opt/cirro/bin/${probe.command}`,
            args: probe.args,
            stdin: { content: probe.stdin, encoding: "utf8" },
          });
          if (result.output === null) return yield* Effect.die({ probe, result });
          if (
            result.output.stdout !== probe.stdout ||
            result.output.exitCode !== probe.exitCode ||
            result.output.stderr !== ""
          )
            return yield* Effect.die({ probe, result });
          return result;
        }),
      );
      return {
        measuredAt: yield* Clock.currentTimeMillis,
        milliseconds: (yield* Clock.currentTimeMillis) - startedAt,
        runtime: "native local Alchemy workerd, R2 and Agent service binding",
        baseDigest: base.digest,
        packageCount: catalog.length,
        commandCount: catalog.reduce((total, item) => total + item.manifest.commands.length, 0),
        sharedBlocks: base.blocks.size,
        sharedBytes: Array.from(base.blocks.values()).reduce(
          (total, bytes) => total + bytes.byteLength,
          0,
        ),
        privateSoftwareBlobs: privateBefore.objects.length,
        catalog,
        runs,
        reclaimed: true,
        scope:
          "Local full default image proof; fixture seeding is separate from deploy-time Alchemy publication; not production latency or billing.",
      };
    }),
  ).pipe(Effect.provide(FetchHttpClient.layer)),
);

console.log(JSON.stringify(report));
