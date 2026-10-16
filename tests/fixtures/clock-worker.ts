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
  OutputMigrationInput,
  StoredRun,
} from "../../src/contracts";
import { tick } from "../../src/cron";
import { reconcile } from "../../src/process";
import type { Env } from "../../src/resources";

type TestEnv = Env & { SELF: Fetcher };
export class Control extends WorkerEntrypoint<TestEnv> {
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
    const request = new Request("https://boxes.test/v1/migrations/process-index-v6", {
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
              if (object === null) return undefined;
              const text = yield* Effect.promise(() => object.text());
              return yield* Schema.decodeUnknownEffect(Schema.fromJsonString(StoredRun))(text);
            }).pipe(
              Effect.repeat({
                until: (record) => record?.status === "running" && record.output !== null,
                schedule: Schedule.spaced("1 millis"),
              }),
            );
            yield* clock.adjust(advance);
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
      CLOCK_CONTROLLED: boolean;
    }
  }
}
