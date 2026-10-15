import { Config, Effect, Redacted, Schema } from "effect";
import { FetchHttpClient } from "effect/http";
import { make } from "../dist/sdk/sdk.js";
import { Action, RunRecord } from "../src/contracts";

await Effect.runPromise(
  Effect.gen(function* () {
    const url = yield* Config.String("CIRRO_URL");
    const token = yield* Config.Redacted("CIRRO_API_KEY");
    const admin = yield* make({ url, token });
    const source = Buffer.from(
      yield* Effect.promise(() => Bun.file("dist/wasi-poll.wasm").arrayBuffer()),
    ).toString("base64");
    const results = yield* Effect.forEach(["millisecond", "nanosecond"], (precision) =>
      Effect.scoped(
        Effect.gen(function* () {
          const id = `poll-${crypto.randomUUID()}`;
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
            permissions: ["read", "write", "execute"],
            expiresInSeconds: 600,
          });
          const client = yield* make({ url, token: Redacted.make(grant.token) });
          const response = yield* Effect.promise(() =>
            fetch(new URL(`/v1/sandboxes/${id}/action`, url), {
              method: "POST",
              headers: {
                authorization: `Bearer ${grant.token}`,
                "content-type": "application/json",
              },
              body: Schema.encodeSync(Schema.fromJsonString(Action))({
                op: "process.run",
                id: "poll",
                language: "wasm",
                source,
                args: [precision],
              }),
              signal: AbortSignal.timeout(90000),
            }),
          );
          const body = yield* Effect.promise(() => response.text());
          if (response.status !== 200) {
            const record = yield* client
              .action(id, { op: "process.get", id: "poll" })
              .pipe(Effect.result);
            console.log(
              JSON.stringify({
                precision,
                passed: false,
                status: response.status,
                contentType: response.headers.get("content-type"),
                ray: response.headers.get("cf-ray"),
                body: body.slice(0, 2000),
                receipt: record._tag,
              }),
            );
            if (record._tag === "Success")
              console.log(
                JSON.stringify({
                  precision,
                  receiptStatus: record.success.status,
                  output: record.success.output,
                }),
              );
            return false;
          }
          const record = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(RunRecord))(body);
          const file = yield* client.action(id, {
            op: "filesystem.readFile",
            path: "/tmp/allocated",
          });
          const passed =
            record.status === "exited" &&
            record.output?.exitCode === 0 &&
            record.output.stdout ===
              "allocation preserved cursor and zeros; poll preserved userdata, EOF and clocks\n" &&
            Buffer.from(file.content, file.encoding).equals(
              Buffer.concat([Buffer.from("original"), Buffer.alloc(8)]),
            );
          console.log(
            JSON.stringify({
              precision,
              passed,
              status: response.status,
              processStatus: record.status,
              output: record.output,
            }),
          );
          return passed;
        }),
      ),
    );
    if (!results.every(Boolean))
      return yield* Effect.die(
        "Native WASI poll proof failed; wire response and retained receipt reported above",
      );
  }).pipe(Effect.provide(FetchHttpClient.layer)),
);
