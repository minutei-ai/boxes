import { Config, Effect, Redacted, Schema } from "effect";
import { FetchHttpClient } from "effect/http";
import { make } from "../dist/sdk/sdk.js";
import { FilesystemSnapshot } from "../src/contracts";

await Effect.runPromise(
  Effect.scoped(
    Effect.gen(function* () {
      const url = yield* Config.String("CIRRO_URL");
      const token = yield* Config.Redacted("CIRRO_API_KEY");
      const admin = yield* make({ url, token });
      const id = `inode-proof-${crypto.randomUUID()}`;
      yield* Effect.acquireRelease(
        admin.create({
          id,
          policy: {
            networkHosts: [],
            interruptBudget: 1000,
            memoryBytes: 8388608,
            maxOutputBytes: 1048576,
          },
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
        permissions: ["read", "write", "execute", "manage"],
        expiresInSeconds: 600,
      });
      const owner = yield* make({ url, token: Redacted.make(grant.token) });
      const writeGrant = yield* admin.mintCapability(id, {
        permissions: ["write"],
        expiresInSeconds: 600,
      });
      const writer = yield* make({ url, token: Redacted.make(writeGrant.token) });
      const initial = Buffer.from(Array.from({ length: 262143 }, (_, index) => index % 251));
      yield* owner.action(id, {
        op: "filesystem.writeFile",
        path: "/data",
        content: initial.toString("base64"),
        encoding: "base64",
      });
      yield* writer.action(id, {
        op: "filesystem.link",
        from: "/data",
        to: "/alias",
        follow: false,
      });
      yield* owner.action(id, { op: "filesystem.symlink", path: "/link", target: "alias" });
      yield* owner.action(id, {
        op: "filesystem.chown",
        path: "/data",
        uid: 123,
        gid: 456,
        follow: true,
      });
      yield* owner.action(id, { op: "filesystem.chmod", path: "/data", mode: 0o200 });
      yield* writer.action(id, { op: "filesystem.appendFile", path: "/link", content: "é" });
      const denied = yield* writer
        .action(id, { op: "filesystem.readFile", path: "/data" })
        .pipe(Effect.flip);
      if (denied._tag !== "BoxesError" || denied.status !== 403)
        return yield* Effect.die("Write-only grant permitted a read");
      yield* writer.action(id, { op: "filesystem.truncate", path: "/alias", size: 262144 });
      yield* writer.action(id, { op: "filesystem.truncate", path: "/link", size: 262149 });
      yield* owner.action(id, { op: "filesystem.chmod", path: "/data", mode: 0o600 });
      const expected = Buffer.alloc(262149);
      initial.copy(expected);
      expected[262143] = 0xc3;
      const file = yield* owner.action(id, { op: "filesystem.readFile", path: "/alias" });
      if (!Buffer.from(file.content, file.encoding).equals(expected))
        return yield* Effect.die("Binary append/shrink/growth content mismatch");
      const before = yield* owner.action(id, {
        op: "filesystem.stat",
        path: "/data",
        follow: true,
      });
      const alias = yield* owner.action(id, {
        op: "filesystem.stat",
        path: "/alias",
        follow: true,
      });
      if (
        before.inode !== alias.inode ||
        before.nlink !== 2 ||
        alias.uid !== 123 ||
        alias.gid !== 456
      )
        return yield* Effect.die("Hard-link identity or ownership mismatch");
      const snapshot = yield* owner.action(id, { op: "filesystem.export", maxBytes: 1048576 });
      if (!snapshot.source.filesystem.entries.some((entry) => entry.type === "hardlink"))
        return yield* Effect.die("Snapshot omitted hard-link identity");
      yield* owner.action(id, { op: "filesystem.remove", path: "/data", recursive: false });
      yield* owner.action(id, { op: "filesystem.restore", snapshot });
      const restored = yield* owner.action(id, { op: "filesystem.export", maxBytes: 1048576 });
      const encode = Schema.encodeSync(Schema.fromJsonString(FilesystemSnapshot));
      if (encode(snapshot) !== encode(restored))
        return yield* Effect.die("Alias-preserving snapshot round trip differs");
      const stat = yield* owner.action(id, { op: "filesystem.stat", path: "/data", follow: true });
      const restoredAlias = yield* owner.action(id, {
        op: "filesystem.stat",
        path: "/alias",
        follow: true,
      });
      if (stat.inode === before.inode || stat.inode !== restoredAlias.inode || stat.nlink !== 2)
        return yield* Effect.die("Restored inode allocation or shared identity mismatch");
      const result = yield* owner.action(id, {
        op: "process.run",
        id: "shell",
        language: "shell",
        source: "! false && echo opened > /first > /second; cat /second",
      });
      if (
        result.status !== "exited" ||
        result.output?.exitCode !== 0 ||
        result.output.stdout !== "opened\n"
      )
        return yield* Effect.die("Negated pipeline or ordered redirection failed");
      const empty = yield* owner.action(id, { op: "filesystem.readFile", path: "/first" });
      if (empty.content !== "") return yield* Effect.die("Earlier output open did not truncate");
      console.log(
        JSON.stringify({
          passed: true,
          target: new URL(url).origin,
          transport: "Effect FetchHttpClient; authenticated remote Worker",
          features: [
            "write-only append",
            "write-only truncate",
            "binary block boundary",
            "zero-filled growth",
            "hard links and ownership",
            "alias-preserving snapshot restore",
            "shell pipeline negation",
            "ordered stdout redirections",
          ],
          limitations:
            "Does not establish remote service-binding transport, performance/cost, arbitrary-crash recovery or historical interpreter heap compatibility",
        }),
      );
    }),
  ).pipe(Effect.provide(FetchHttpClient.layer)),
);
