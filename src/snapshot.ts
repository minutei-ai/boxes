import { Effect, Schema } from "effect";
import { Kernel } from "../dist/kernel/cirro_kernel";
import { Fault, FilesystemSnapshot } from "./contracts";
import { kernelCall, write } from "./storage";
import type { Env } from "./resources";

export const importSnapshot = Effect.fn("filesystem.importSnapshot")(function* (
  env: Env,
  id: string,
  kernel: Kernel,
  snapshot: typeof FilesystemSnapshot.Type,
) {
  const entries = snapshot.source.filesystem.entries;
  const byPath = new Map(entries.map((entry) => [entry.path, entry]));
  if (byPath.size !== entries.length || byPath.get("/")?.type !== "directory")
    return yield* new Fault({
      code: "EINVAL",
      status: 400,
      message: "Snapshot requires one directory root and unique paths",
    });
  const prepared = yield* Effect.forEach(entries, (entry) =>
    Effect.gen(function* () {
      const canonical = yield* kernelCall(() => kernel.canonical(entry.path, "/"));
      if (canonical !== entry.path || !entry.path.startsWith("/"))
        return yield* new Fault({
          code: "EINVAL",
          status: 400,
          message: "Snapshot paths must be absolute and canonical",
        });
      if (
        entry.path !== "/" &&
        byPath.get(entry.path.slice(0, entry.path.lastIndexOf("/")) || "/")?.type !== "directory"
      )
        return yield* new Fault({
          code: "EINVAL",
          status: 400,
          message: "Snapshot parent must be a directory entry",
        });
      const mode = Number.parseInt(entry.mode, 8);
      if (mode > 0o777 || (entry.type === "symlink" && mode !== 0o777))
        return yield* new Fault({
          code: "EINVAL",
          status: 400,
          message: "Snapshot mode cannot be represented by the kernel",
        });
      if (entry.type === "symlink")
        yield* kernelCall(() =>
          kernel.canonical(entry.target, entry.path.slice(0, entry.path.lastIndexOf("/")) || "/"),
        );
      if (entry.type !== "file") return { entry, mode, data: undefined };
      const data = Buffer.from(entry.content, "base64");
      if (data.toString("base64") !== entry.content)
        return yield* new Fault({
          code: "EINVAL",
          status: 400,
          message: "Snapshot file content must be canonical base64",
        });
      if (data.byteLength > 16_777_216)
        return yield* new Fault({
          code: "EFBIG",
          status: 413,
          message: "Snapshot file exceeds 16 MiB",
        });
      return { entry, mode, data };
    }),
  );
  yield* kernelCall(() => kernel.reset_snapshot_root());
  const ordered = prepared.toSorted(
    (left, right) => left.entry.path.length - right.entry.path.length,
  );
  yield* Effect.forEach(ordered, ({ entry }) => {
    if (entry.type === "directory" && entry.path !== "/")
      return kernelCall(() => kernel.mkdir(entry.path, false));
    return Effect.void;
  });
  yield* Effect.forEach(ordered, ({ entry, data }) => {
    if (entry.type === "file" && data !== undefined)
      return write(env, id, kernel, entry.path, data);
    if (entry.type === "symlink") return kernelCall(() => kernel.symlink(entry.target, entry.path));
    return Effect.void;
  });
  yield* Effect.forEach(ordered.toReversed(), ({ entry, mode }) =>
    Effect.gen(function* () {
      yield* kernelCall(() => kernel.chown(entry.path, entry.uid, entry.gid, false));
      if (entry.type !== "symlink") yield* kernelCall(() => kernel.chmod(entry.path, mode));
    }),
  );
  yield* kernelCall(() => kernel.finish_snapshot_root());
});
