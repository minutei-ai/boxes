import { Config, Effect, Redacted, Schema } from "effect";
import { FetchHttpClient } from "effect/http";
import { make } from "../dist/sdk/sdk.js";
import { FilesystemSnapshot } from "../src/contracts";

await Effect.runPromise(
  Effect.gen(function* () {
    const url = yield* Config.String("CIRRO_URL");
    const token = yield* Config.Redacted("CIRRO_API_KEY");
    const admin = yield* make({ url, token });
    const id = `restore-${crypto.randomUUID()}`;
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
      permissions: ["read", "write", "manage"],
      expiresInSeconds: 600,
    });
    const boxes = yield* make({ url, token: Redacted.make(grant.token) });
    yield* boxes.action(id, {
      op: "filesystem.writeFile",
      path: "/data",
      content: Buffer.from([0, 255, 128, 10]).toString("base64"),
      encoding: "base64",
    });
    yield* boxes.action(id, { op: "filesystem.symlink", path: "/alias", target: "data" });
    yield* boxes.action(id, {
      op: "filesystem.chown",
      path: "/data",
      uid: 1000,
      gid: 1001,
      follow: true,
    });
    const before = yield* boxes.action(id, { op: "filesystem.stat", path: "/data", follow: true });
    const snapshot = yield* boxes.action(id, { op: "filesystem.export", maxBytes: 1048576 });
    yield* boxes.action(id, { op: "filesystem.remove", path: "/data", recursive: false });
    yield* boxes.action(id, {
      op: "filesystem.writeFile",
      path: "/extra",
      content: "obsolete",
      encoding: "utf8",
    });
    const status = yield* boxes.action(id, { op: "vm.status" });
    yield* boxes.action(id, { op: "filesystem.restore", snapshot });
    const restored = yield* boxes.action(id, { op: "filesystem.export", maxBytes: 1048576 });
    const encode = Schema.encodeSync(Schema.fromJsonString(FilesystemSnapshot));
    if (encode(restored) !== encode(snapshot))
      return yield* Effect.die("Snapshot differs after restore");
    const after = yield* boxes.action(id, { op: "filesystem.stat", path: "/data", follow: true });
    if (after.inode <= before.inode || after.uid !== before.uid || after.gid !== before.gid)
      return yield* Effect.die("Restored identity or ownership differs");
    const current = yield* boxes.action(id, { op: "vm.status" });
    if (
      current.generation !== status.generation + 1 ||
      JSON.stringify(current.policy) !== JSON.stringify(status.policy)
    )
      return yield* Effect.die("Restore changed policy or publication count");
    const limited = yield* admin.mintCapability(id, {
      permissions: ["read", "write"],
      expiresInSeconds: 600,
    });
    const writer = yield* make({ url, token: Redacted.make(limited.token) });
    const denied = yield* writer
      .action(id, { op: "filesystem.restore", snapshot })
      .pipe(Effect.flip);
    if (denied._tag !== "BoxesError" || denied.status !== 403)
      return yield* Effect.die("Restore did not require manage");
    yield* boxes.action(id, { op: "vm.dispose" });
    console.log(
      JSON.stringify({
        checks: 5,
        passed: true,
        target: "production",
        feature: "filesystem.restore",
      }),
    );
  }).pipe(Effect.provide(FetchHttpClient.layer)),
);
