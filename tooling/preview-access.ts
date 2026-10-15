import { Effect, Layer } from "effect";
import { Access } from "alchemy/Cloudflare";

export const PublicPreviewAccess = Layer.succeed(
  Access.Access,
  Access.Access.of({
    getAccessHeaders: Effect.fn("remoteBindingProof.publicPreviewAccess")(function* (
      domain: string,
    ) {
      const response = yield* Effect.promise((signal) =>
        fetch(`https://${domain}`, { redirect: "manual", keepalive: false, signal }),
      ).pipe(
        Effect.timeoutOrElse({
          duration: 5000,
          orElse: () =>
            Effect.fail(
              new Access.AccessError({ message: "Preview access verification timed out" }),
            ),
        }),
      );
      const body = response.body;
      if (body !== null) yield* Effect.promise(() => body.cancel());
      if ((response.status >= 300 && response.status < 400) || response.status >= 500)
        return yield* new Access.AccessError({
          message: "Preview access could not be verified without interactive authentication",
        });
      return {};
    }),
  }),
);
