import { Clock, Config, Crypto, Effect, Redacted, Schedule, Schema } from "effect";
import { BunCrypto } from "@effect/platform-bun";
import { FetchHttpClient } from "effect/http";
import { make } from "../dist/sdk/sdk.js";
import {
  DispatchReceipt,
  FileContent,
  Id,
  ReclamationProgress,
  RunRecord,
} from "../dist/sdk/contracts.js";

const Report = Schema.Struct({
  target: Schema.String,
  sandboxId: Id,
  measuredAt: Schema.Int,
  queued: RunRecord,
  scopedMaintenanceDenied: Schema.Literal(401),
  repair: DispatchReceipt,
  blocker: RunRecord,
  completed: RunRecord,
  confirmed: FileContent,
  reclaimed: ReclamationProgress,
});

const report = await Effect.runPromise(
  Effect.scoped(
    Effect.gen(function* () {
      const target = yield* Config.String("CIRRO_URL");
      const credential = yield* Config.Redacted("CIRRO_API_KEY");
      const crypto = yield* Crypto.Crypto;
      const sandboxId = `repair-proof-${yield* crypto.randomUUIDv4()}`;
      const admin = yield* make({ url: target, token: credential });
      yield* admin.create({
        id: sandboxId,
        policy: {
          networkHosts: [],
          interruptBudget: 100000,
          memoryBytes: 8388608,
          maxOutputBytes: 1048576,
        },
      });
      yield* Effect.logInfo({ phase: "created", sandboxId });
      const grant = yield* admin.mintCapability(sandboxId, {
        permissions: ["read", "write", "execute", "manage"],
        expiresInSeconds: 600,
      });
      const client = yield* Effect.acquireRelease(
        make({ url: target, token: Redacted.make(grant.token) }),
        (client) => client.action(sandboxId, { op: "vm.dispose" }).pipe(Effect.orDie),
      );
      yield* client.action(sandboxId, {
        op: "filesystem.writeFile",
        path: "/confirmed",
        content: "",
        encoding: "utf8",
      });
      const wasm = yield* Effect.promise(() => Bun.file("dist/wasi-stdin.wasm").arrayBuffer());
      yield* client.action(sandboxId, {
        op: "process.spawn",
        stdinMode: "pipe",
        execution: {
          op: "process.run",
          id: "blocker",
          language: "wasm",
          source: Buffer.from(wasm).toString("base64"),
        },
      });
      yield* client.action(sandboxId, { op: "process.get", id: "blocker" }).pipe(
        Effect.repeat({
          until: (record) => record.status === "running" && record.output?.stdout === "ready\n",
          schedule: Schedule.spaced("100 millis"),
        }),
        Effect.timeout("15 seconds"),
      );
      yield* client.action(sandboxId, {
        op: "process.spawn",
        execution: {
          op: "process.run",
          id: "confirmed",
          language: "javascript",
          source:
            'export default async ({ tools }) => tools.call({ op: "filesystem.appendFile", path: "/confirmed", content: "A" })',
        },
      });
      const queued = yield* client.action(sandboxId, { op: "process.get", id: "confirmed" });
      if (queued.status !== "queued")
        return yield* Effect.die(
          "The bounded native consumer did not retain queued work during stdin wait",
        );
      yield* Effect.logInfo({ phase: "queued", sandboxId, processId: queued.id });
      const denied = yield* Effect.promise(() =>
        fetch(new URL("/v1/maintenance/process-dispatch", target), {
          method: "POST",
          keepalive: false,
          headers: { authorization: `Bearer ${grant.token}`, "content-type": "application/json" },
          body: Schema.encodeSync(Schema.fromJsonString(Schema.Struct({})))({}),
          signal: AbortSignal.timeout(60000),
        }),
      );
      if (denied.status !== 401)
        return yield* Effect.die("Scoped authority reached administrator maintenance");
      yield* Effect.promise(() => denied.text());
      const response = yield* Effect.promise(() =>
        fetch(new URL("/v1/maintenance/process-dispatch", target), {
          method: "POST",
          keepalive: false,
          headers: {
            authorization: `Bearer ${Redacted.value(credential)}`,
            "content-type": "application/json",
          },
          body: Schema.encodeSync(Schema.fromJsonString(Schema.Struct({})))({}),
          signal: AbortSignal.timeout(60000),
        }),
      );
      if (response.status !== 200)
        return yield* Effect.die({
          message: "Native process repair failed",
          status: response.status,
        });
      const repair = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(DispatchReceipt))(
        yield* Effect.promise(() => response.text()),
      );
      if (repair.notifications < 1) return yield* Effect.die("Repair did not notify queued work");
      yield* client.action(sandboxId, { op: "process.stdin.close", id: "blocker", offset: 0 });
      const blocker = yield* client.action(sandboxId, {
        op: "process.wait",
        id: "blocker",
        timeoutMs: 25000,
      });
      const completed = yield* client.action(sandboxId, {
        op: "process.wait",
        id: "confirmed",
        timeoutMs: 25000,
      });
      const confirmed = yield* client.action(sandboxId, {
        op: "filesystem.readFile",
        path: "/confirmed",
      });
      if (
        blocker.status !== "exited" ||
        blocker.output?.exitCode !== 0 ||
        blocker.output.stdout !== "ready\n\nbytes=0\n" ||
        completed.status !== "exited" ||
        completed.output?.exitCode !== 0 ||
        Buffer.from(confirmed.content, confirmed.encoding).toString() !== "A"
      )
        return yield* Effect.die("Queued repair did not retain confirmed single-entry execution");
      yield* client.action(sandboxId, { op: "vm.dispose" });
      const reclaimed = yield* client
        .action(sandboxId, { op: "vm.reclaim", limit: 1000 })
        .pipe(Effect.repeat({ until: (progress) => progress.status !== "pending", times: 16 }));
      if (reclaimed.status !== "complete")
        return yield* Effect.die("Repair proof collection did not finish");
      return {
        target,
        sandboxId,
        measuredAt: yield* Clock.currentTimeMillis,
        queued,
        scopedMaintenanceDenied: 401 as const,
        repair,
        blocker,
        completed,
        confirmed,
        reclaimed,
      };
    }),
  ).pipe(
    Effect.provide([FetchHttpClient.layer, BunCrypto.layer]),
    Effect.provideService(FetchHttpClient.RequestInit, { keepalive: false }),
  ),
);
console.log(Schema.encodeSync(Schema.fromJsonString(Report))(report));
