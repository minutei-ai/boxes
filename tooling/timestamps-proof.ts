import { Config, Effect, Redacted } from "effect";
import { FetchHttpClient } from "effect/http";
import { make } from "../dist/sdk/sdk.js";

await Effect.runPromise(
  Effect.gen(function* () {
    const url = yield* Config.String("CIRRO_URL");
    const token = yield* Config.Redacted("CIRRO_API_KEY");
    const admin = yield* make({ url, token });
    const id = `timestamps-${crypto.randomUUID()}`;
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
    const boxes = yield* make({ url, token: Redacted.make(grant.token) });
    yield* boxes.action(id, {
      op: "filesystem.writeFile",
      path: "/data",
      content: "preserved",
      encoding: "utf8",
    });
    yield* boxes.action(id, { op: "filesystem.symlink", path: "/alias", target: "data" });
    const before = yield* boxes.action(id, { op: "filesystem.stat", path: "/data", follow: true });
    yield* boxes.action(id, {
      op: "filesystem.utimes",
      path: "/alias",
      atimeNs: 0n,
      mtimeNs: 18446744073709551615n,
      follow: false,
    });
    const link = yield* boxes.action(id, { op: "filesystem.stat", path: "/alias", follow: false });
    if (link.atimeNs !== "0" || link.mtimeNs !== "18446744073709551615")
      return yield* Effect.die("symlink precision mismatch");
    const target = yield* boxes.action(id, { op: "filesystem.stat", path: "/data", follow: true });
    if (target.ctimeNs !== before.ctimeNs) return yield* Effect.die("symlink affected target");
    const guest = yield* boxes.action(id, {
      op: "process.run",
      id: "guest-times",
      language: "typescript",
      source:
        'export default async ({ tools }) => tools.call({ op: "filesystem.utimes", path: "/alias", atimeNs: "9007199254740993", mtimeNs: "1234567890123456789", follow: true })',
    });
    if (guest.status !== "exited" || guest.output?.exitCode !== 0) return yield* Effect.die(guest);
    const changed = yield* boxes.action(id, { op: "filesystem.stat", path: "/data", follow: true });
    if (
      changed.atimeNs !== "9007199254740993" ||
      changed.mtimeNs !== "1234567890123456789" ||
      changed.inode !== before.inode ||
      changed.size !== before.size
    )
      return yield* Effect.die("target precision or identity mismatch");
    const file = yield* boxes.action(id, { op: "filesystem.readFile", path: "/data" });
    if (Buffer.from(file.content, file.encoding).toString() !== "preserved")
      return yield* Effect.die("file bytes changed");
    const readonly = yield* admin.mintCapability(id, {
      permissions: ["read"],
      expiresInSeconds: 600,
    });
    const reader = yield* make({ url, token: Redacted.make(readonly.token) });
    const denied = yield* reader
      .action(id, {
        op: "filesystem.utimes",
        path: "/data",
        atimeNs: 0n,
        mtimeNs: 0n,
        follow: true,
      })
      .pipe(Effect.flip);
    if (denied._tag !== "BoxesError" || denied.status !== 403)
      return yield* Effect.die("authorization mismatch");
    yield* boxes.action(id, { op: "vm.dispose" });
    console.log(
      JSON.stringify({
        checks: 6,
        passed: true,
        target: "production",
        feature: "filesystem.utimes",
      }),
    );
  }).pipe(Effect.provide(FetchHttpClient.layer)),
);
