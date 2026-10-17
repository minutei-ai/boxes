import { env, WorkerEntrypoint } from "cloudflare:workers";
import { Clock, Effect, Fiber, Schema, Schedule, Latch } from "effect";
import * as TestClock from "effect/testing/TestClock";
import platformProxy from "@alchemy.run/cloudflare-runtime/core/platform-proxy/worker";
import { PLATFORM_PROXY_PREFIX } from "@alchemy.run/cloudflare-runtime/core/platform-proxy/PlatformProxyProtocol";
import type { Fetcher } from "@cloudflare/workers-types/experimental";
import { consume, handleRequest } from "../../src/index";
export { Agent } from "../../src/index";
import {
  ProcessCancelAction,
  ProcessDelivery,
  ProcessListAction,
  ProcessInputAction,
  OutputMigrationInput,
  ContextMigrationInput,
  ContextMigrationReceipt,
  StoredRun,
  StoredContext,
  Id,
} from "../../src/contracts";
import { tick } from "../../src/cron";
import { reconcile } from "../../src/process";
import { authorize } from "../../src/auth";
import { acquireContext } from "../../src/contexts";
import { migrateContexts } from "../../src/context-migration";
import { ContextClaimProof } from "./context-checkpoint-contract";
import { readOutputRange } from "../../src/output";
import type { Env } from "../../src/resources";

const ContextMigrationTrace = ContextMigrationReceipt.mapFields((fields) => ({
  ...fields,
  reads: Schema.Int,
}));

type TestEnv = Env & { SELF: Fetcher };
export class Control extends WorkerEntrypoint<TestEnv> {
  contextBusyDelivery(
    sandboxId: string,
    token: string,
    id: string,
    messages: Parameters<Fetcher["queue"]>[1],
  ) {
    const bindings = this.env;
    return Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const capability = yield* authorize(bindings, token, sandboxId);
          const now = yield* Clock.currentTimeMillis;
          yield* acquireContext(
            bindings,
            capability,
            id,
            "blocking",
            now + 60000,
            null,
            "javascript",
          );
          return yield* Effect.promise(() => bindings.SELF.queue("executions", messages));
        }),
      ),
    );
  }
  contextClaims(sandboxId: string, token: string, id: string, now: number) {
    const bindings = this.env;
    return Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const clock = yield* TestClock.make();
          yield* clock.setTime(now);
          return yield* Effect.scoped(
            Effect.gen(function* () {
              const capability = yield* authorize(bindings, token, sandboxId);
              const key = `sandboxes/${sandboxId}/contexts/${id}.json`;
              const original = yield* Effect.promise(() => bindings.OBJECTS.head(key));
              if (original === null) return yield* Effect.die("Missing test context");
              const first = yield* Effect.scoped(
                acquireContext(bindings, capability, id, "same", now + 60_000, null, "javascript"),
              );
              const restored = yield* Effect.promise(() => bindings.OBJECTS.head(key));
              const proof = yield* Effect.scoped(
                Effect.gen(function* () {
                  const second = yield* acquireContext(
                    bindings,
                    capability,
                    id,
                    "same",
                    now + 60_000,
                    null,
                    "javascript",
                  );
                  const stale = yield* Effect.promise(() =>
                    bindings.OBJECTS.put(
                      key,
                      Schema.encodeSync(Schema.fromJsonString(StoredContext))({
                        ...first.original,
                        updatedAt: now,
                      }),
                      { onlyIf: { etagMatches: first.etag } },
                    ),
                  );
                  const held = yield* Effect.promise(() => bindings.OBJECTS.get(key));
                  if (held === null) return yield* Effect.die("Claim disappeared");
                  const record = yield* Schema.decodeUnknownEffect(
                    Schema.fromJsonString(StoredContext),
                  )(yield* Effect.promise(() => held.text()));
                  return {
                    claims: [first.record.claimId, second.record.claimId],
                    epochs: [first.etag, second.etag],
                    sameIdleEtag: restored?.etag === original.etag,
                    staleRejected: stale === null,
                    heldState: record.state,
                  };
                }),
              );
              return Schema.encodeSync(ContextClaimProof)(proof);
            }),
          ).pipe(Effect.provideService(Clock.Clock, clock));
        }),
      ),
    );
  }
  inputRequests(sandboxId: string, token: string, action: typeof ProcessInputAction.Type) {
    const requests: string[] = [];
    const bindings = {
      ...this.env,
      OBJECTS: new Proxy(this.env.OBJECTS, {
        get(target, property) {
          if (property === "get")
            return (...args: Parameters<Env["OBJECTS"]["get"]>) => {
              requests.push(`get:${args[0]}`);
              return target.get(...args).then((value) => {
                requests.push(`received:${args[0]}`);
                return value;
              });
            };
          if (property === "head")
            return (...args: Parameters<Env["OBJECTS"]["head"]>) => {
              requests.push(`head:${args[0]}`);
              return target.head(...args);
            };
          if (property === "put")
            return (...args: Parameters<Env["OBJECTS"]["put"]>) => {
              requests.push(`put:${args[0]}`);
              return target.put(...args);
            };
          const value = Reflect.get(target, property, target);
          if (typeof value === "function") return value.bind(target);
          return value;
        },
      }),
    };
    const request = new Request(`https://boxes.test/v1/sandboxes/${sandboxId}/action`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: Schema.encodeSync(Schema.fromJsonString(ProcessInputAction))(action),
    });
    return Effect.runPromise(
      Effect.gen(function* () {
        const response = yield* handleRequest(request, bindings);
        return {
          status: response.status,
          body: yield* Effect.promise(() => response.text()),
          requests,
        };
      }),
    );
  }
  migrateProcessIndex(token: string, cursor: typeof OutputMigrationInput.Type.cursor) {
    const counts = { writes: 0, notifications: 0 };
    const bindings = {
      ...this.env,
      EVENTS: new Proxy(this.env.EVENTS, {
        get(target, property) {
          if (property === "send")
            return (...args: Parameters<Env["EVENTS"]["send"]>) => {
              counts.notifications += 1;
              return target.send(...args);
            };
          const value = Reflect.get(target, property, target);
          if (typeof value === "function") return value.bind(target);
          return value;
        },
      }),
      OBJECTS: new Proxy(this.env.OBJECTS, {
        get(target, property) {
          if (property === "put")
            return (...args: Parameters<Env["OBJECTS"]["put"]>) => {
              if (args[0].startsWith("processes/")) counts.writes += 1;
              return target.put(...args);
            };
          const value = Reflect.get(target, property, target);
          if (typeof value === "function") return value.bind(target);
          return value;
        },
      }),
    };
    const request = new Request("https://boxes.test/v1/migrations/process-index-v7", {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: Schema.encodeSync(Schema.fromJsonString(OutputMigrationInput))({ cursor }),
    });
    return Effect.runPromise(
      Effect.gen(function* () {
        const response = yield* handleRequest(request, bindings);
        return {
          status: response.status,
          body: yield* Effect.promise(() => response.text()),
          writes: counts.writes,
          notifications: counts.notifications,
        };
      }),
    );
  }
  listProcesses(sandboxId: string, token: string, action: typeof ProcessListAction.Type) {
    const counts = { receiptReads: 0, inputReads: 0, listings: 0 };
    const bindings = {
      ...this.env,
      OBJECTS: new Proxy(this.env.OBJECTS, {
        get(target, property) {
          if (property === "get")
            return (...args: Parameters<Env["OBJECTS"]["get"]>) => {
              if (args[0].startsWith("processes/")) counts.receiptReads += 1;
              if (args[0].startsWith("process-input/")) counts.inputReads += 1;
              return target.get(...args);
            };
          if (property === "list")
            return (...args: Parameters<Env["OBJECTS"]["list"]>) => {
              counts.listings += 1;
              return target.list(...args);
            };
          const value = Reflect.get(target, property, target);
          if (typeof value === "function") return value.bind(target);
          return value;
        },
      }),
    };
    const request = new Request(`https://boxes.test/v1/sandboxes/${sandboxId}/action`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: Schema.encodeSync(Schema.fromJsonString(ProcessListAction))(action),
    });
    return Effect.runPromise(
      Effect.gen(function* () {
        const response = yield* handleRequest(request, bindings);
        return {
          status: response.status,
          body: yield* Effect.promise(() => response.text()),
          ...counts,
        };
      }),
    );
  }
  cancelAfterCompletion(sandboxId: string, token: string, id: string) {
    const native = this.env;
    const key = `processes/${sandboxId}/${id}.json`;
    const state = { deliveries: 0 };
    const bindings = {
      ...native,
      OBJECTS: new Proxy(native.OBJECTS, {
        get(target, property) {
          if (property === "put")
            return async (...args: Parameters<Env["OBJECTS"]["put"]>) => {
              if (args[0] === key && state.deliveries === 0) {
                const object = await target.head(key);
                if (object === null) return target.put(...args);
                state.deliveries += 1;
                await native.SELF.queue("executions", [
                  {
                    id: "cancel-completion-race",
                    timestamp: new Date(Effect.runSync(Clock.currentTimeMillis)),
                    attempts: 1,
                    body: Schema.encodeSync(ProcessDelivery)({ key, eTag: object.etag }),
                  },
                ]);
              }
              return target.put(...args);
            };
          const value = Reflect.get(target, property, target);
          if (typeof value === "function") return value.bind(target);
          return value;
        },
      }),
    };
    const request = new Request(`https://boxes.test/v1/sandboxes/${sandboxId}/action`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: Schema.encodeSync(Schema.fromJsonString(ProcessCancelAction))({
        op: "process.cancel",
        id,
      }),
    });
    return Effect.runPromise(
      Effect.gen(function* () {
        const response = yield* handleRequest(request, bindings);
        return {
          status: response.status,
          body: yield* Effect.promise(() => response.text()),
          deliveries: state.deliveries,
        };
      }),
    );
  }
  repair() {
    const counts = { receiptReads: 0 };
    const bindings = {
      ...this.env,
      OBJECTS: new Proxy(this.env.OBJECTS, {
        get(target, property) {
          if (property === "get")
            return (...args: Parameters<Env["OBJECTS"]["get"]>) => {
              counts.receiptReads += 1;
              return target.get(...args);
            };
          const value = Reflect.get(target, property, target);
          if (typeof value === "function") return value.bind(target);
          return value;
        },
      }),
    };
    return Effect.runPromise(
      reconcile(bindings).pipe(
        Effect.map((result) => ({ ...result, receiptReads: counts.receiptReads })),
      ),
    );
  }
  contextMigration(input: typeof ContextMigrationInput.Type) {
    const counts = { reads: 0 };
    const bindings = {
      ...this.env,
      OBJECTS: new Proxy(this.env.OBJECTS, {
        get(target, property) {
          if (property === "get")
            return (...args: Parameters<Env["OBJECTS"]["get"]>) => {
              counts.reads += 1;
              return target.get(...args);
            };
          const value = Reflect.get(target, property, target);
          if (typeof value === "function") return value.bind(target);
          return value;
        },
      }),
    };
    return Effect.runPromise(
      migrateContexts(bindings, input).pipe(
        Effect.map((result) => ContextMigrationTrace.make({ ...result, reads: counts.reads })),
      ),
    );
  }
  schedules(now: number) {
    const bindings = this.env;
    return Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const clock = yield* TestClock.make();
          yield* clock.setTime(now);
          return yield* tick(bindings).pipe(Effect.provideService(Clock.Clock, clock));
        }),
      ),
    );
  }
  notify(messages: Parameters<Env["EVENTS"]["sendBatch"]>[0]) {
    return this.env.EVENTS.sendBatch(messages);
  }
  deliver(queue: string, messages: Parameters<Fetcher["queue"]>[1]) {
    return this.env.SELF.queue(queue, messages);
  }
}
export default {
  fetch(request: Parameters<typeof platformProxy.fetch>[0], bindings: TestEnv) {
    if (new URL(request.url).pathname.startsWith(`${PLATFORM_PROXY_PREFIX}/`))
      return platformProxy.fetch(request, bindings);
    const advance = request.headers.get("x-boxes-test-clock-advance");
    const start = request.headers.get("x-boxes-test-clock-start");
    if (advance === null && start === null)
      return Effect.runPromise(handleRequest(request, bindings));
    return Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const elapsed = yield* Effect.gen(function* () {
            if (advance === null) return 0;
            return yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Int))(advance);
          });
          const started = yield* Effect.gen(function* () {
            if (start === null) return yield* Clock.currentTimeMillis;
            return yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Int))(start);
          });
          const clock = yield* TestClock.make();
          yield* clock.setTime(started);
          const sleeping = yield* Latch.make();
          const requestClock: Clock.Clock = {
            ...clock,
            sleep: (duration) => sleeping.open.pipe(Effect.andThen(clock.sleep(duration))),
          };
          const response = yield* handleRequest(request, bindings).pipe(
            Effect.provideService(Clock.Clock, requestClock),
            Effect.forkChild,
          );
          const drive = sleeping.await.pipe(
            Effect.andThen(clock.adjust(elapsed)),
            Effect.andThen(Fiber.join(response)),
          );
          return yield* Effect.raceFirst(Fiber.join(response), drive);
        }),
      ),
    );
  },
  queue(batch: MessageBatch<unknown>, bindings: TestEnv) {
    if (env.CLOCK_CONTROLLED === false) return Effect.runPromise(consume(batch, bindings));
    return Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const start = yield* Schema.decodeUnknownEffect(Schema.Int)(env.CLOCK_START);
          const advance = yield* Schema.decodeUnknownEffect(Schema.Int)(env.CLOCK_ADVANCE);
          const afterOutput = yield* Schema.decodeUnknownEffect(Schema.NullOr(Schema.String))(
            env.CLOCK_ADVANCE_AFTER_OUTPUT,
          );
          const clock = yield* TestClock.make();
          yield* clock.setTime(start);
          const delivery = yield* consume(batch, bindings).pipe(
            Effect.provideService(Clock.Clock, clock),
            Effect.forkChild,
          );
          if (advance === 0 || batch.messages.length === 0) return yield* Fiber.join(delivery);
          const event = yield* Schema.decodeUnknownEffect(ProcessDelivery)(batch.messages[0].body);
          const drive = Effect.gen(function* () {
            yield* Effect.gen(function* () {
              const object = yield* Effect.promise(() => bindings.OBJECTS.get(event.key));
              if (object === null) return false;
              const text = yield* Effect.promise(() => object.text());
              const record = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(StoredRun))(
                text,
              );
              if (record.status !== "running" || record.output === null) return false;
              if (afterOutput === null) return true;
              const sandboxId = yield* Schema.decodeUnknownEffect(Id)(event.key.split("/")[1]);
              const stdout = yield* readOutputRange(
                bindings,
                sandboxId,
                record.output.stdout,
                0,
                record.output.stdout.size,
              );
              if (stdout.toString().includes(afterOutput)) return true;
              yield* clock.adjust("10 millis");
              return false;
            }).pipe(
              Effect.repeat({
                until: (ready) => ready,
                schedule: Schedule.spaced("1 millis"),
              }),
            );
            yield* clock.adjust(Math.max(0, start + advance - (yield* clock.currentTimeMillis)));
            return yield* Fiber.join(delivery);
          });
          return yield* Effect.raceFirst(Fiber.join(delivery), drive);
        }),
      ),
    );
  },
};
declare global {
  namespace Cloudflare {
    interface Env {
      CLOCK_START: number;
      CLOCK_ADVANCE: number;
      CLOCK_ADVANCE_AFTER_OUTPUT: string | null;
      CLOCK_CONTROLLED: boolean;
    }
  }
}
