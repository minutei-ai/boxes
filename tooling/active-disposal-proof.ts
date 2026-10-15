import { Clock, Config, Crypto, Effect, Fiber, Redacted, Schema } from "effect";
import { BunCrypto } from "@effect/platform-bun";
import { FetchHttpClient } from "effect/http";
import { make } from "../dist/sdk/sdk.js";
import { Id, RunRecord, RecoveryStatus, ReclamationProgress } from "../dist/sdk/contracts.js";

const Report = Schema.Struct({
  target: Schema.String,
  sandboxId: Id,
  measuredAt: Schema.Int,
  runtime: Schema.Literal("wasm"),
  status: Schema.Literal("cancelled"),
  stdout: Schema.String,
  readsDenied: Schema.Literal(true),
  startedAt: RunRecord.fields.startedAt,
  inlineDeadline: RecoveryStatus,
  reclaimed: ReclamationProgress,
});

const report = await Effect.runPromise(
  Effect.scoped(
    Effect.gen(function* () {
      const url = yield* Config.String("CIRRO_URL");
      const token = yield* Config.Redacted("CIRRO_API_KEY");
      const crypto = yield* Crypto.Crypto;
      const id = `active-disposal-${yield* crypto.randomUUIDv4()}`;
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
      yield* Effect.logInfo({ phase: "created", sandboxId: id });
      const grant = yield* admin.mintCapability(id, {
        permissions: ["read", "execute", "manage"],
        expiresInSeconds: 600,
      });
      const client = yield* Effect.acquireRelease(
        make({ url, token: Redacted.make(grant.token) }),
        (client) => client.action(id, { op: "vm.dispose" }).pipe(Effect.orDie),
      );
      const bytes = yield* Effect.promise(() =>
        Bun.file("dist/wasi-background-ready.wasm").arrayBuffer(),
      );
      const pending = yield* client
        .action(id, {
          op: "process.run",
          id: "blocked",
          language: "wasm",
          source: Buffer.from(bytes).toString("base64"),
        })
        .pipe(Effect.forkScoped);
      const observed = yield* Effect.gen(function* () {
        const deadline = (yield* Clock.currentTimeMillis) + 15000;
        while ((yield* Clock.currentTimeMillis) < deadline) {
          const record = yield* client
            .action(id, {
              op: "process.get",
              id: "blocked",
            })
            .pipe(Effect.result);
          if (record._tag === "Success") {
            if (
              record.success.status === "running" &&
              record.success.output?.stdout === "continuation entered\n"
            )
              return record.success;
            if (record.success.status !== "running")
              return yield* Effect.die("WASI guest terminated before disposal observation");
          } else if (record.failure._tag !== "BoxesError" || record.failure.error !== "ENOENT")
            return yield* record.failure;
          yield* Effect.sleep(50);
        }
        return yield* Effect.die(
          "WASI guest did not acknowledge entry before the observation deadline",
        );
      });
      const inlineDeadline = yield* client.action(id, {
        op: "process.recovery.status",
        id: "blocked",
      });
      if (
        inlineDeadline.state !== "running" ||
        inlineDeadline.resumable ||
        inlineDeadline.checkpoints !== 0 ||
        inlineDeadline.deadlineAt !== observed.startedAt + 900000
      )
        return yield* Effect.die("Inline WASI did not retain its default recovery deadline");
      yield* client.action(id, { op: "vm.dispose" });
      const completed = yield* Fiber.join(pending);
      if (
        completed.language !== "wasm" ||
        completed.status !== "cancelled" ||
        completed.output?.stdout !== observed.output?.stdout ||
        completed.output?.result !== null ||
        completed.output?.exitCode !== null
      )
        return yield* Effect.die("Disposed WASI guest did not retain cancelled output");
      const denied = yield* client
        .action(id, {
          op: "process.get",
          id: "blocked",
        })
        .pipe(Effect.flip);
      if (denied._tag !== "BoxesError" || denied.error !== "ENOENT")
        return yield* Effect.die("Disposed process remained publicly readable");
      const reclaimed = yield* client
        .action(id, { op: "vm.reclaim", limit: 1000 })
        .pipe(Effect.repeat({ until: (progress) => progress.status !== "pending", times: 16 }));
      if (reclaimed.status !== "complete")
        return yield* Effect.die("Inline WASI proof collection did not finish");
      return {
        target: url,
        sandboxId: id,
        measuredAt: yield* Clock.currentTimeMillis,
        runtime: "wasm" as const,
        status: "cancelled" as const,
        stdout: completed.output.stdout,
        readsDenied: true as const,
        startedAt: observed.startedAt,
        inlineDeadline,
        reclaimed,
      };
    }),
  ).pipe(
    Effect.provide([FetchHttpClient.layer, BunCrypto.layer]),
    Effect.provideService(FetchHttpClient.RequestInit, { keepalive: false }),
  ),
);
console.log(Schema.encodeSync(Schema.fromJsonString(Report))(report));
