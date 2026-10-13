import { Clock, Effect, Match, Schema } from "effect";
import { requirePermission } from "./auth";
import {
  Capability,
  DirectoryEntries,
  Fault,
  FileContent,
  FileStat,
  FilesystemAction,
  Success,
  BatchReadResults,
  BatchWriteResults,
  DirectoryTree,
  DirectoryExclusions,
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
    "filesystem.readFiles",
    "filesystem.readdirRecursive",
    "filesystem.realpath",
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
  const now = yield* Clock.currentTimeNanos;
  yield* kernelCall(() => kernel.set_time(now));
  return yield* Match.value(action).pipe(
    Match.when({ op: "filesystem.readFiles" }, (input) =>
      Effect.gen(function* () {
        const metadata = yield* Effect.forEach(input.paths, (path) =>
          kernelCall(() => kernel.stat(path, true)).pipe(
            Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(FileStat))),
            Effect.result,
          ),
        );
        const total = metadata.reduce((sum, result) => {
          if (result._tag === "Success" && result.success.kind === "file")
            return sum + result.success.size;
          return sum;
        }, 0);
        if (total > 16_777_216)
          return yield* new Fault({
            code: "EFBIG",
            status: 413,
            message: "Batch reads are limited to 16 MiB total content",
          });
        const results = yield* Effect.forEach(
          input.paths,
          (path) =>
            Effect.gen(function* () {
              const result = yield* read(env, id, kernel, path).pipe(Effect.result);
              if (result._tag === "Success")
                return {
                  path,
                  content: result.success.toString("base64"),
                  encoding: "base64" as const,
                };
              if (result.failure._tag === "Fault")
                return {
                  path,
                  content: null,
                  encoding: "base64" as const,
                  error: result.failure.message,
                  code: result.failure.code,
                };
              return yield* result.failure;
            }),
          { concurrency: 1 },
        );
        return results satisfies typeof BatchReadResults.Type;
      }),
    ),
    Match.when({ op: "filesystem.writeFiles" }, (input) =>
      Effect.gen(function* () {
        const contentBytes = input.entries.reduce((sum, entry) => {
          if (entry.encoding === "base64") return sum + Buffer.byteLength(entry.content, "base64");
          return sum + Buffer.byteLength(entry.content, "utf8");
        }, 0);
        if (contentBytes > 16_777_216)
          return yield* new Fault({
            code: "EFBIG",
            status: 413,
            message: "Batch writes are limited to 16 MiB total content",
          });
        const beforeNodes = kernel.node_count();
        const results = yield* Effect.forEach(input.entries, (entry) =>
          Effect.gen(function* () {
            const result = yield* Effect.gen(function* () {
              if (
                entry.encoding === "base64" &&
                !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
                  entry.content,
                )
              )
                return yield* new Fault({
                  code: "EINVAL",
                  status: 400,
                  message: "Invalid canonical base64",
                });
              const target = yield* kernelCall(() => kernel.canonical(entry.path, "/"));
              const parent = target.slice(0, target.lastIndexOf("/"));
              if (parent.length > 0) yield* kernelCall(() => kernel.mkdir(parent, true));
              yield* write(env, id, kernel, target, Buffer.from(entry.content, entry.encoding));
            }).pipe(Effect.result);
            if (result._tag === "Success") return { path: entry.path, success: true as const };
            if (result.failure._tag === "Fault")
              return {
                path: entry.path,
                success: false as const,
                error: result.failure.message,
                code: result.failure.code,
              };
            return yield* result.failure;
          }),
        );
        if (results.some((result) => result.success) || kernel.node_count() !== beforeNodes)
          yield* publish(env, id, session);
        return results satisfies typeof BatchWriteResults.Type;
      }),
    ),
    Match.when({ op: "filesystem.readdirRecursive" }, (input) =>
      kernelCall(() =>
        kernel.readdir_recursive(
          input.path,
          input.maxDepth ?? 64,
          Schema.encodeSync(Schema.fromJsonString(DirectoryExclusions))(input.exclude ?? []),
        ),
      ).pipe(Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(DirectoryTree)))),
    ),
    Match.when({ op: "filesystem.realpath" }, (input) =>
      kernelCall(() => kernel.realpath(input.path)).pipe(Effect.map((path) => ({ path }))),
    ),
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
