import { mkdir, rm } from "node:fs/promises";
await rm("dist/sdk", { recursive: true, force: true });
await mkdir("dist/sdk", { recursive: true });
const result = await Bun.build({
  entrypoints: ["src/sdk.ts", "src/sdk-rpc.ts", "src/sdk-tanstack.ts", "src/contracts.ts"],
  outdir: "dist/sdk",
  target: "browser",
  format: "esm",
  packages: "external",
  splitting: true,
});
if (!result.success) {
  console.error(result.logs);
  process.exit(1);
}
const declarations = Bun.spawn(["bunx", "tsc", "-p", "tsconfig.sdk.json"], {
  stdout: "inherit",
  stderr: "inherit",
});
if ((await declarations.exited) !== 0) process.exit(1);
