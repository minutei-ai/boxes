import { Effect, Schema } from "effect";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";
import {
  Action,
  ActionResponses,
  CreateSandbox,
  ErrorResponse,
  Id,
  MintCapability,
  Status,
  TokenResponse,
} from "./contracts";

export class BoxesError extends Schema.TaggedError<BoxesError>()("BoxesError", {
  status: Schema.Int,
  ...ErrorResponse.fields,
}) {}

export const ClientConfig = Schema.Struct({
  url: Schema.String.check(Schema.isPattern(/^https?:\/\/[^\s]+$/)),
  token: Schema.Redacted(Schema.String.check(Schema.isMinLength(1))),
});

export const make = Effect.fn("boxes.client.make")(function* (
  configuration: typeof ClientConfig.Type,
) {
  const config = yield* Schema.decodeUnknownEffect(ClientConfig)(configuration);
  const url = yield* Schema.decodeUnknownEffect(Schema.URLFromString)(config.url);
  const client = yield* HttpClient.HttpClient;
  const post = Effect.fn("boxes.client.post")(function* <
    I extends Schema.Constraint,
    O extends Schema.Constraint,
  >(path: string, input: I, output: O, value: I["Type"]) {
    const request = yield* HttpClientRequest.schemaBodyJson(input, { onExcessProperty: "error" })(
      HttpClientRequest.post(new URL(path, url)).pipe(HttpClientRequest.bearerToken(config.token)),
      value,
    );
    const response = yield* client.execute(request);
    if (response.status < 200 || response.status >= 300) {
      const failure = yield* HttpClientResponse.schemaBodyJson(ErrorResponse)(response);
      return yield* new BoxesError({ status: response.status, ...failure });
    }
    return yield* HttpClientResponse.schemaBodyJson(output)(response);
  });
  return {
    create: Effect.fn("boxes.client.create")((input: typeof CreateSandbox.Type) =>
      post("/v1/sandboxes", CreateSandbox, Status, input),
    ),
    mintCapability: Effect.fn("boxes.client.mintCapability")(function* (
      id: typeof Id.Type,
      input: typeof MintCapability.Type,
    ) {
      const sandboxId = yield* Schema.decodeUnknownEffect(Id)(id);
      return yield* post(
        `/v1/sandboxes/${sandboxId}/capabilities`,
        MintCapability,
        TokenResponse,
        input,
      );
    }),
    action: Effect.fn("boxes.client.action")(function* <Op extends typeof Action.Type.op>(
      id: typeof Id.Type,
      input: typeof Action.Type & { readonly op: Op },
    ) {
      const sandboxId = yield* Schema.decodeUnknownEffect(Id)(id);
      const response: (typeof ActionResponses)[Op] = ActionResponses[input.op];
      return yield* post(`/v1/sandboxes/${sandboxId}/action`, Action, response, input);
    }),
  };
});
