import { Effect, Schema, Struct } from "effect";
import { archive } from "./code";
import { RunRecord, RunMetadata, WasmProgram } from "./contracts";
import { StorageFailure } from "./storage";
import type { Env } from "./resources";

class WasmMigrationFailure extends Schema.TaggedError<WasmMigrationFailure>()(
  "WasmMigrationFailure",
  { key: Schema.String },
) {}

export const migrateWasm = Effect.fn("migration.wasmInputs")(function* (env: Env) {
  const cursors: (string | undefined)[] = [undefined];
  const migrated = { count: 0 };
  while (cursors.length > 0) {
    const cursor = cursors.shift();
    const page = yield* Effect.tryPromise({
      try: () => {
        if (cursor === undefined)
          return env.OBJECTS.list({
            prefix: "sandboxes/",
            limit: 100,
            include: ["customMetadata"],
          });
        return env.OBJECTS.list({
          prefix: "sandboxes/",
          limit: 100,
          cursor,
          include: ["customMetadata"],
        });
      },
      catch: (cause) => new StorageFailure({ cause }),
    });
    yield* Effect.forEach(
      page.objects.filter(
        (object) => object.key.includes("/runs/") && object.key.endsWith(".json"),
      ),
      (object) =>
        Effect.gen(function* () {
          if (object.customMetadata?.summary !== undefined) {
            const metadata = yield* Schema.decodeUnknownEffect(RunMetadata)(object.customMetadata);
            if (metadata.summary.language !== "wasm") return;
          }
          const stored = yield* Effect.tryPromise({
            try: () => env.OBJECTS.get(object.key),
            catch: (cause) => new StorageFailure({ cause }),
          });
          if (stored === null || stored.size > 8_388_608)
            return yield* new WasmMigrationFailure({ key: object.key });
          const text = yield* Effect.tryPromise({
            try: () => stored.text(),
            catch: (cause) => new StorageFailure({ cause }),
          });
          const record = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(RunRecord))(text);
          if (record.language !== "wasm") return;
          const prefix = object.key.slice(0, object.key.indexOf("/runs/"));
          const codeKey = `${prefix}/code/${record.sourceHash}`;
          const code = yield* Effect.tryPromise({
            try: () => env.OBJECTS.get(codeKey),
            catch: (cause) => new StorageFailure({ cause }),
          });
          if (code === null) return yield* new WasmMigrationFailure({ key: codeKey });
          if (code.customMetadata?.format === "program-json") return;
          if (code.size > 786_432) return yield* new WasmMigrationFailure({ key: codeKey });
          const data = yield* Effect.tryPromise({
            try: () => code.arrayBuffer(),
            catch: (cause) => new StorageFailure({ cause }),
          });
          const digest = yield* Effect.promise(() => crypto.subtle.digest("SHA-256", data));
          if (Buffer.from(digest).toString("hex") !== record.sourceHash)
            return yield* new WasmMigrationFailure({ key: codeKey });
          const program = {
            language: "wasm" as const,
            source: Buffer.from(data).toString("base64"),
            argv: [],
            env: {},
            stdin: "",
          } satisfies typeof WasmProgram.Type;
          const id = prefix.slice("sandboxes/".length);
          const sourceHash = yield* archive(env, id, program);
          const converted = { ...record, sourceHash };
          const written = yield* Effect.tryPromise({
            try: () =>
              env.OBJECTS.put(
                object.key,
                Schema.encodeSync(Schema.fromJsonString(RunRecord))(converted),
                {
                  onlyIf: { etagMatches: stored.etag },
                  customMetadata: Schema.encodeSync(RunMetadata)({
                    summary: Struct.omit(converted, ["output"]),
                  }),
                },
              ),
            catch: (cause) => new StorageFailure({ cause }),
          });
          if (written === null) return yield* new WasmMigrationFailure({ key: object.key });
          migrated.count += 1;
        }),
    );
    if (page.truncated) cursors.push(page.cursor);
  }
  return { migrated: migrated.count };
});
