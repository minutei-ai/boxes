import { join } from "node:path";
import { Effect, Schema } from "effect";

export const bindingConsumer = Effect.fn("proof.bindingConsumer")(function* (sdkDirectory: string) {
  const sdkPackage = yield* Schema.decodeUnknownEffect(
    Schema.Struct({ name: Schema.Literal("@minutei-ai/boxes"), version: Schema.String }),
  )(yield* Effect.promise(() => Bun.file(join(sdkDirectory, "package.json")).json()));
  const sdkModules = new Map([
    ["../../src/sdk", Bun.resolveSync("@minutei-ai/boxes", sdkDirectory)],
    ["../../src/sdk-rpc", Bun.resolveSync("@minutei-ai/boxes/rpc", sdkDirectory)],
    ["../../src/sdk-tanstack", Bun.resolveSync("@minutei-ai/boxes/tanstack", sdkDirectory)],
    ["../../src/contracts", Bun.resolveSync("@minutei-ai/boxes/contracts", sdkDirectory)],
  ]);
  const sdkModulesSha256 = Object.fromEntries(
    yield* Effect.forEach(sdkModules, ([name, path]) =>
      Effect.gen(function* () {
        const bytes = yield* Effect.promise(() => Bun.file(path).arrayBuffer());
        const digest = Buffer.from(
          yield* Effect.promise(() => crypto.subtle.digest("SHA-256", bytes)),
        ).toString("hex");
        return [name, digest] as const;
      }),
    ),
  );
  const built = yield* Effect.promise(() =>
    Bun.build({
      entrypoints: ["tests/fixtures/remote-binding-worker.ts"],
      target: "browser",
      format: "esm",
      minify: true,
      external: ["cloudflare:workers"],
      plugins: [
        {
          name: "installed-boxes-sdk",
          setup(builder) {
            builder.onResolve(
              { filter: /^\.\.\/\.\.\/src\/(sdk|sdk-rpc|sdk-tanstack|contracts)$/ },
              (args) => {
                const path = sdkModules.get(args.path);
                if (path === undefined) return;
                return { path };
              },
            );
            builder.onResolve({ filter: /^effect($|\/)/ }, (args) => ({
              path: Bun.resolveSync(args.path, sdkDirectory),
            }));
          },
        },
      ],
    }),
  );
  const module = built.outputs[0];
  if (!built.success || module === undefined || built.outputs.length !== 1)
    return yield* Effect.die({ message: "Binding consumer bundle failed", logs: built.logs });
  const bytes = yield* Effect.promise(() => module.arrayBuffer());
  const consumerBundleSha256 = Buffer.from(
    yield* Effect.promise(() => crypto.subtle.digest("SHA-256", bytes)),
  ).toString("hex");
  return { bytes, version: sdkPackage.version, sdkModulesSha256, consumerBundleSha256 };
});
