import { Effect, Schema, Stream } from "effect";
import { Fault } from "./contracts";

export class HttpFailure extends Schema.TaggedError<HttpFailure>()("HttpFailure", {
  cause: Schema.Unknown,
}) {}
export const readBounded = Effect.fn("http.readBounded")(function* (
  body: ReadableStream<Uint8Array> | null,
  maximum: number,
) {
  if (body === null) return Buffer.alloc(0);
  const chunks: Uint8Array[] = [];
  yield* Stream.fromReadableStream({
    evaluate: () => body,
    onError: (cause) => new HttpFailure({ cause }),
  }).pipe(
    Stream.runFoldEffect(
      () => 0,
      (size, chunk) => {
        const next = size + chunk.byteLength;
        if (next > maximum)
          return Effect.fail(
            new Fault({ code: "EFBIG", status: 413, message: "Payload byte limit exceeded" }),
          );
        chunks.push(chunk);
        return Effect.succeed(next);
      },
    ),
  );
  return Buffer.concat(chunks);
});
