import { Effect, Ref, Schema } from "effect";
const Options = Schema.Struct({ delay: Schema.Int, body: Schema.String });
const requests = Effect.runSync(Ref.make(0));
export default {
  fetch(request: Request, env: { OPTIONS: typeof Options.Type }) {
    return Effect.runPromise(
      Effect.gen(function* () {
        const options = yield* Schema.decodeUnknownEffect(Options)(env.OPTIONS);
        const url = new URL(request.url);
        if (url.pathname === "/count") return Response.json(yield* Ref.get(requests));
        yield* Ref.update(requests, (value) => value + 1);
        yield* Effect.sleep(options.delay);
        if (options.body.length > 0) return new Response(options.body);
        if (url.pathname === "/redirect")
          return new Response(null, {
            status: 307,
            headers: { location: "https://forbidden.example/echo" },
          });
        if (url.pathname === "/accepted")
          return Response.json((yield* Effect.promise(() => request.arrayBuffer())).byteLength);
        if (url.pathname === "/large") return new Response(new Uint8Array(2048));
        if (url.pathname === "/large-header")
          return new Response(null, { headers: { "x-large": "a".repeat(8193) } });
        const body = yield* Effect.promise(() => request.arrayBuffer());
        return Response.json(
          {
            method: request.method,
            header: request.headers.get("x-agent"),
            auth: request.headers.get("authorization"),
            body: Array.from(new Uint8Array(body)),
            url: request.url,
          },
          { status: 201, headers: { "x-origin": "native-workerd" } },
        );
      }),
    );
  },
};
