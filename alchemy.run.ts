import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import { Effect, Layer, Schema } from "effect";
import { bucket, worker } from "./src/resources";

const state = Layer.unwrap(
  Alchemy.Stage.pipe(
    Effect.map((stage) => {
      if (stage === "dev" || stage.startsWith("dev_")) return Alchemy.localState();
      return Cloudflare.state();
    }),
  ),
);
const Output = Schema.Struct({ url: Schema.String, bucketName: Schema.String });
export class Cirro extends Alchemy.Stack<Cirro, typeof Output.Type>()("cirro") {}
export default Cirro.make(
  { providers: Cloudflare.providers(), state },
  Effect.gen(function* () {
    const service = yield* worker;
    const objects = yield* bucket;
    return { url: service.url, bucketName: objects.bucketName };
  }),
);
