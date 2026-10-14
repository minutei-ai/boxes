import { copyFile, mkdir, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { Schema } from "effect";

const Package = Schema.Struct({
  name: Schema.String,
  version: Schema.String,
  license: Schema.String,
  repository: Schema.Struct({ type: Schema.String, url: Schema.String }),
});
const root = Schema.decodeUnknownSync(Package)(await Bun.file("package.json").json());
const directory = "dist/runtime-package";
await rm(directory, { recursive: true, force: true });
await mkdir(directory, { recursive: true });
const assets = await readdir("dist/worker");
for (const asset of assets) await copyFile(join("dist/worker", asset), join(directory, asset));
await copyFile("LICENSE", join(directory, "LICENSE"));
await Bun.write(
  join(directory, "package.json"),
  JSON.stringify({
    name: "@minutei-ai/boxes-runtime",
    version: root.version,
    license: root.license,
    repository: root.repository,
    type: "module",
    files: [...assets, "LICENSE"],
    exports: { "./worker": "./index.js", "./package.json": "./package.json" },
  }),
);
const packageProcess = Bun.spawn(["bun", "pm", "pack", "--destination", "/tmp"], {
  cwd: directory,
  stdout: "inherit",
  stderr: "inherit",
});
process.exitCode = await packageProcess.exited;
