import { Effect, Redacted, Schema } from "effect";
import { makeBinding } from "../../src/sdk";
import { FileContent, Id, RunRecord } from "../../src/contracts";

export const BindingProof = Schema.Struct({
  file: FileContent,
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
