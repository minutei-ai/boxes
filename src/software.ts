import { Clock, Effect, Match, Schema } from "effect";
import { requirePermission } from "./auth";
import {
  Capability,
  Fault,
  PackageInstallation,
  SoftwareAction,
  SoftwareCatalog,
} from "./contracts";
import { fetchAuthorized } from "./network";
import { readBounded } from "./http";
import { kernelCall, open, publish, read, StorageFailure } from "./storage";
import type { Env } from "./resources";

export const software = Effect.fn("software.action")(function* (
  env: Env,
  capability: typeof Capability.Type,
  action: typeof SoftwareAction.Type,
) {
  if (action.op === "software.list" || action.op === "software.installed")
    yield* requirePermission(capability, "read");
  else {
    yield* requirePermission(capability, "manage");
    yield* requirePermission(capability, "write");
  }
  const session = yield* open(env, capability.sandboxId);
  const now = yield* Clock.currentTimeNanos;
  yield* kernelCall(() => session.kernel.set_time(now));
  const result = yield* Match.value(action).pipe(
    Match.when({ op: "software.install" }, (input) =>
      Effect.gen(function* () {
        const bytes = yield* Effect.gen(function* () {
          if ("path" in input.source) {
            yield* requirePermission(capability, "read");
            return yield* read(env, capability.sandboxId, session.kernel, input.source.path);
          }
          const response = yield* fetchAuthorized(
            capability,
            session.head.policy,
            input.source.url,
          );
          if (!response.ok)
            return yield* new Fault({
              code: "EINVAL",
              status: 400,
              message: "Package source did not return a successful response",
            });
          return yield* readBounded(response.body, 16_777_216);
        });
        if (input.source.digest !== undefined) {
          const digest = yield* Effect.promise(async () =>
            Buffer.from(await crypto.subtle.digest("SHA-256", bytes)).toString("hex"),
          );
          if (`sha256:${digest}` !== input.source.digest)
            return yield* new Fault({
              code: "EINVAL",
              status: 400,
              message: "Package digest does not match the pinned source",
            });
        }
        const json = yield* kernelCall(() => session.kernel.install_package(bytes));
        const installed = yield* Schema.decodeUnknownEffect(
          Schema.fromJsonString(PackageInstallation),
          { onExcessProperty: "error" },
        )(json);
        yield* Effect.forEach(
          installed.blocks,
          (block) =>
            Effect.tryPromise({
              try: () =>
                env.OBJECTS.put(
                  `sandboxes/${capability.sandboxId}/blobs/${block.hash}`,
                  bytes.subarray(block.offset, block.offset + block.length),
                  { onlyIf: { etagDoesNotMatch: "*" } },
                ),
              catch: (cause) => new StorageFailure({ cause }),
            }),
          { concurrency: 4 },
        );
        return installed.installed;
      }),
    ),
    Match.when({ op: "software.uninstall" }, (input) =>
      Effect.gen(function* () {
        yield* kernelCall(() => session.kernel.uninstall_package(input.packageId));
        return { ok: true };
      }),
    ),
    Match.when({ op: "software.link" }, (input) =>
      Effect.gen(function* () {
        yield* kernelCall(() =>
          session.kernel.link_package(input.packageId, input.command, input.alias ?? input.command),
        );
        return { ok: true };
      }),
    ),
    Match.whenOr({ op: "software.list" }, { op: "software.installed" }, () =>
      kernelCall(() => session.kernel.packages()).pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(SoftwareCatalog))),
      ),
    ),
    Match.exhaustive,
  );
  if (action.op !== "software.list" && action.op !== "software.installed") {
    const finishedAt = yield* Clock.currentTimeMillis;
    if (capability.expiresAt <= finishedAt)
      return yield* new Fault({ code: "UNAUTHORIZED", status: 401, message: "Capability expired" });
    yield* publish(env, capability.sandboxId, session);
  }
  return result;
});
