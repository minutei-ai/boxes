import { Cause, Effect, Redacted, Schema } from "effect";
import { BoxesError, makeBinding } from "@minutei-ai/boxes";
import {
  Action,
  AgentRequest,
  ErrorResponse,
  Id,
  ReclamationProgress,
} from "@minutei-ai/boxes/contracts";

const Path = Schema.Tuple([
  Schema.Literal(""),
  Schema.Literal("v1"),
  Schema.Literal("sandboxes"),
  Id,
  Schema.Literal("action"),
]);
export default {
  fetch(request: Request, env: { BOXES: Fetcher }) {
    return Effect.runPromise(
      Effect.gen(function* () {
        const path = yield* Schema.decodeUnknownEffect(Path)(
          new URL(request.url).pathname.split("/"),
        );
        const authorization = request.headers.get("authorization");
        if (authorization === null || !authorization.startsWith("Bearer "))
          return yield* new BoxesError({
            status: 401,
            error: "UNAUTHORIZED",
            message: "Capability required",
          });
        const token = yield* Schema.decodeUnknownEffect(AgentRequest.fields.token)(
          authorization.slice(7),
        );
        const action = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Action), {
          onExcessProperty: "error",
        })(yield* Effect.promise(() => request.text()));
        if (request.method !== "POST" || action.op !== "vm.reclaim")
          return yield* new BoxesError({
            status: 400,
            error: "UNSUPPORTED",
            message: "Reclamation proof only",
          });
        const client = yield* makeBinding(env.BOXES, Redacted.make(token));
        const progress = yield* client.action(path[3], action);
        return new Response(
          Schema.encodeSync(Schema.fromJsonString(ReclamationProgress))(progress),
          {
            headers: { "content-type": "application/json", "cache-control": "no-store" },
          },
        );
      }).pipe(
        Effect.catchTag("BoxesError", (failure) =>
          Effect.succeed(
            new Response(
              Schema.encodeSync(Schema.fromJsonString(ErrorResponse))({
                error: failure.error,
                message: failure.message,
              }),
              {
                status: failure.status,
                headers: { "content-type": "application/json", "cache-control": "no-store" },
              },
            ),
          ),
        ),
        Effect.catchCause((cause) =>
          Effect.succeed(
            new Response(Cause.pretty(cause), {
              status: 500,
              headers: { "content-type": "text/plain", "cache-control": "no-store" },
            }),
          ),
        ),
      ),
    );
  },
};
