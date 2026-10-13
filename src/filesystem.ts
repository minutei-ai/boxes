import { Effect, Match, Schema } from "effect";
import { requirePermission } from "./auth";
import {
  Capability,
  DirectoryEntries,
  Fault,
  FileContent,
  FileStat,
  FilesystemAction,
  Success,
} from "./contracts";
import { kernelCall, open, publish, read, write } from "./storage";
import type { Env } from "./resources";

export const filesystem = Effect.fn("filesystem.action")(function* (
  env: Env,
  capability: typeof Capability.Type,
  action: typeof FilesystemAction.Type,
) {
  const id = capability.sandboxId;
  const reads = [
    "filesystem.readFile",
    "filesystem.stat",
    "filesystem.readdir",
    "filesystem.exists",
    "filesystem.readlink",
  ];
  const permission = Match.value(reads.includes(action.op)).pipe(
    Match.when(true, () => "read" as const),
    Match.orElse(() => "write" as const),
  );
  yield* requirePermission(capability, permission);
  const session = yield* open(env, id);
  const kernel = session.kernel;
  return yield* Match.value(action).pipe(
    Match.when({ op: "filesystem.readFile" }, (input) =>
      Effect.gen(function* () {
        const data = yield* read(env, id, kernel, input.path);
        return {
          content: data.toString("base64"),
          encoding: "base64" as const,
          size: data.byteLength,
        } satisfies typeof FileContent.Type;
      }),
    ),
    Match.when({ op: "filesystem.stat" }, (input) =>
      Effect.gen(function* () {
        const json = yield* kernelCall(() => kernel.stat(input.path, input.follow));
        return yield* Schema.decodeUnknownEffect(Schema.fromJsonString(FileStat))(json);
      }),
    ),
    Match.when({ op: "filesystem.exists" }, (input) =>
      kernelCall(() => kernel.stat(input.path, true)).pipe(
        Effect.as({ exists: true }),
        Effect.catchTag("Fault", (fault) => {
          if (fault.code === "ENOENT") return Effect.succeed({ exists: false });
          return Effect.fail(fault);
        }),
      ),
    ),
    Match.when({ op: "filesystem.readdir" }, (input) =>
      Effect.gen(function* () {
        const json = yield* kernelCall(() => kernel.readdir(input.path));
        return yield* Schema.decodeUnknownEffect(Schema.fromJsonString(DirectoryEntries))(json);
      }),
    ),
    Match.when({ op: "filesystem.readlink" }, (input) =>
      kernelCall(() => kernel.readlink(input.path)).pipe(Effect.map((target) => ({ target }))),
    ),
    Match.when({ op: "filesystem.writeFile" }, (input) =>
      Effect.gen(function* () {
        if (
          input.encoding === "base64" &&
          !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(input.content)
        ) {
          return yield* new Fault({
            code: "EINVAL",
            status: 400,
            message: "Invalid canonical base64",
          });
        }
        const data = Buffer.from(input.content, input.encoding);
        yield* write(env, id, kernel, input.path, data);
        yield* publish(env, id, session);
        return { ok: true } satisfies typeof Success.Type;
      }),
    ),
    Match.when({ op: "filesystem.appendFile" }, (input) =>
      Effect.gen(function* () {
        yield* requirePermission(capability, "read");
        const before = yield* read(env, id, kernel, input.path).pipe(
          Effect.catchTag("Fault", (fault) => {
            if (fault.code === "ENOENT") return Effect.succeed(Buffer.alloc(0));
            return Effect.fail(fault);
          }),
        );
        yield* write(
          env,
          id,
          kernel,
          input.path,
          Buffer.concat([before, Buffer.from(input.content)]),
        );
        yield* publish(env, id, session);
        return { ok: true } satisfies typeof Success.Type;
      }),
    ),
    Match.when({ op: "filesystem.truncate" }, (input) =>
      Effect.gen(function* () {
        yield* requirePermission(capability, "read");
        const before = yield* read(env, id, kernel, input.path);
        const data = Buffer.alloc(input.size);
        before.copy(data, 0, 0, input.size);
        yield* write(env, id, kernel, input.path, data);
        yield* publish(env, id, session);
        return { ok: true } satisfies typeof Success.Type;
      }),
    ),
    Match.when({ op: "filesystem.mkdir" }, (input) =>
      Effect.gen(function* () {
        yield* kernelCall(() => kernel.mkdir(input.path, input.recursive));
        yield* publish(env, id, session);
        return { ok: true } satisfies typeof Success.Type;
      }),
    ),
    Match.when({ op: "filesystem.move" }, (input) =>
      Effect.gen(function* () {
        yield* kernelCall(() => kernel.rename(input.from, input.to));
        yield* publish(env, id, session);
        return { ok: true } satisfies typeof Success.Type;
      }),
    ),
    Match.when({ op: "filesystem.remove" }, (input) =>
      Effect.gen(function* () {
        yield* kernelCall(() => kernel.remove(input.path, input.recursive));
        yield* publish(env, id, session);
        return { ok: true } satisfies typeof Success.Type;
      }),
    ),
    Match.when({ op: "filesystem.symlink" }, (input) =>
      Effect.gen(function* () {
        yield* kernelCall(() => kernel.symlink(input.target, input.path));
        yield* publish(env, id, session);
        return { ok: true } satisfies typeof Success.Type;
      }),
    ),
    Match.when({ op: "filesystem.chmod" }, (input) =>
      Effect.gen(function* () {
        yield* kernelCall(() => kernel.chmod(input.path, input.mode));
        yield* publish(env, id, session);
        return { ok: true } satisfies typeof Success.Type;
      }),
    ),
    Match.exhaustive,
  );
});
