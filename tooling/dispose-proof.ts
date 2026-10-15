import { Clock, Config, Crypto, Effect, Redacted, Schema } from "effect";
import { BunCrypto } from "@effect/platform-bun";
import { FetchHttpClient } from "effect/http";
import { make } from "../src/sdk";

const Report = Schema.Struct({
  target: Schema.String,
  measuredAt: Schema.Int,
  concurrentDisposals: Schema.Int,
  repeated: Schema.Boolean,
  readsDenied: Schema.Boolean,
  manageRequired: Schema.Boolean,
  idReuseDenied: Schema.Boolean,
});
const report = await Effect.runPromise(
  Effect.scoped(
    Effect.gen(function* () {
      const url = yield* Config.String("CIRRO_URL");
      const token = yield* Config.Redacted("CIRRO_API_KEY");
      const crypto = yield* Crypto.Crypto;
      const id = `dispose-${yield* crypto.randomUUIDv4()}`;
      const admin = yield* make({ url, token });
      const policy = {
        networkHosts: [],
        interruptBudget: 1000,
        memoryBytes: 8388608,
        maxOutputBytes: 1048576,
      };
      yield* admin.create({ id, policy });
      const grant = yield* admin.mintCapability(id, {
        permissions: ["read", "write", "execute", "manage"],
        expiresInSeconds: 600,
      });
      const readGrant = yield* admin.mintCapability(id, {
        permissions: ["read"],
        expiresInSeconds: 600,
      });
      const client = yield* Effect.acquireRelease(
        make({ url, token: Redacted.make(grant.token) }),
        (client) => client.action(id, { op: "vm.dispose" }).pipe(Effect.orDie),
      );
      const disposals = yield* Effect.forEach(
        [0, 1, 2],
        () => client.action(id, { op: "vm.dispose" }),
        { concurrency: 3 },
      );
      if (disposals.some((result) => !result.ok))
        return yield* Effect.die("Concurrent disposal did not complete");
      yield* client.action(id, { op: "vm.dispose" });
      const status = yield* client.action(id, { op: "vm.status" }).pipe(Effect.flip);
      if (status._tag !== "BoxesError" || status.error !== "ENOENT")
        return yield* Effect.die("Disposed sandbox remained readable");
      const reader = yield* make({ url, token: Redacted.make(readGrant.token) });
      const denied = yield* reader.action(id, { op: "vm.dispose" }).pipe(Effect.flip);
      if (denied._tag !== "BoxesError" || denied.error !== "FORBIDDEN")
        return yield* Effect.die("Disposal did not require manage");
      const reuse = yield* admin.create({ id, policy }).pipe(Effect.flip);
      if (reuse._tag !== "BoxesError" || reuse.error !== "EEXIST")
        return yield* Effect.die("Disposed sandbox ID was reused");
      return {
        target: url,
        measuredAt: yield* Clock.currentTimeMillis,
        concurrentDisposals: disposals.length,
        repeated: true,
        readsDenied: true,
        manageRequired: true,
        idReuseDenied: true,
      };
    }),
  ).pipe(Effect.provide([FetchHttpClient.layer, BunCrypto.layer])),
);
console.log(await Effect.runPromise(Schema.encodeEffect(Schema.fromJsonString(Report))(report)));
