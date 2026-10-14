import { Effect, Redacted, Schema } from "effect";
import { makeBinding } from "../../src/sdk";
import { FileContent, FileStat, Id, RunRecord } from "../../src/contracts";

export const BindingProof = Schema.Struct({
  file: FileContent,
  stat: FileStat,
  restoredStat: FileStat,
  run: RunRecord,
  denied: Schema.Int,
});
export default {
  fetch(request: Request, env: { BOXES: Fetcher; TOKEN: string }) {
    return Effect.runPromise(
      Effect.gen(function* () {
        const id = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Id))(
          yield* Effect.promise(() => request.text()),
        );
        const admin = yield* makeBinding(env.BOXES, Redacted.make(env.TOKEN));
        const policy = {
          networkHosts: [],
          interruptBudget: 1000,
          memoryBytes: 8388608,
          maxOutputBytes: 1048576,
        };
        yield* admin.create({ id, policy });
        const capability = yield* admin.mintCapability(id, {
          permissions: ["read", "write", "execute", "manage"],
          expiresInSeconds: 600,
        });
        const boxes = yield* makeBinding(env.BOXES, Redacted.make(capability.token));
        yield* boxes.action(id, {
          op: "filesystem.writeFile",
          path: "/binding",
          content: "native binding",
          encoding: "utf8",
        });
        const file = yield* boxes.action(id, { op: "filesystem.readFile", path: "/binding" });
        yield* boxes.action(id, {
          op: "filesystem.utimes",
          path: "/binding",
          atimeNs: 9007199254740993n,
          mtimeNs: 18446744073709551615n,
          follow: true,
        });
        const stat = yield* boxes.action(id, {
          op: "filesystem.stat",
          path: "/binding",
          follow: true,
        });
        const snapshot = yield* boxes.action(id, {
          op: "filesystem.export",
          maxBytes: 1048576,
        });
        yield* boxes.action(id, {
          op: "filesystem.writeFile",
          path: "/binding",
          content: "changed",
          encoding: "utf8",
        });
        yield* boxes.action(id, { op: "filesystem.restore", snapshot });
        const restoredStat = yield* boxes.action(id, {
          op: "filesystem.stat",
          path: "/binding",
          follow: true,
        });
        const restoredFile = yield* boxes.action(id, {
          op: "filesystem.readFile",
          path: "/binding",
        });
        if (restoredFile.content !== file.content)
          return yield* Effect.die("Restore lost file bytes");
        const run = yield* boxes.action(id, {
          op: "typescript.evaluate",
          id: "binding-run",
          expression: "6 * 7",
        });
        const denied = yield* boxes.create({ id: `${id}-denied`, policy }).pipe(Effect.flip);
        if (denied._tag !== "BoxesError") return yield* Effect.die(denied);
        yield* boxes.action(id, { op: "vm.dispose" });
        return new Response(
          Schema.encodeSync(Schema.fromJsonString(BindingProof))({
            file,
            stat,
            restoredStat,
            run,
            denied: denied.status,
          }),
          {
            headers: { "content-type": "application/json" },
          },
        );
      }),
    );
  },
};
