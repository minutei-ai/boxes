const call = globalThis.__call;
const moduleRequest = globalThis.__moduleRequest;
delete globalThis.__moduleRequest;
globalThis.__cirroImport = async (base, specifier, options) => {
  const name = `${specifier}`;
  if (options !== undefined) {
    if (options === null || typeof options !== "object")
      throw new TypeError("Import options must be an object");
    const attributes = options.with;
    if (attributes !== undefined) {
      if (attributes === null || typeof attributes !== "object")
        throw new TypeError("Import attributes must be an object");
      if (Object.keys(attributes).length > 0)
        throw new TypeError("Import attributes are not supported");
    }
  }
  return await moduleRequest(base, name);
};
const finish = globalThis.__finish;
const mode = globalThis.__mode;
delete globalThis.__mode;
const maxOutput = globalThis.__maxOutput;
delete globalThis.__call;
delete globalThis.__finish;
delete globalThis.__maxOutput;
const output = { stdout: "", stderr: "", result: null, exitCode: 0 };
globalThis.__capture = () => JSON.stringify({ stdout: output.stdout, stderr: output.stderr });
const append = (stream, values) => {
  const line =
    values
      .map((value) => {
        if (typeof value === "string") return value;
        return JSON.stringify(value);
      })
      .join(" ") + "\n";
  if (output.stdout.length + output.stderr.length + line.length > maxOutput)
    throw new Error("Output budget exceeded");
  output[stream] += line;
};
const console = Object.freeze({
  log: (...values) => append("stdout", values),
  error: (...values) => append("stderr", values),
  warn: (...values) => append("stderr", values),
});
globalThis.console = console;
const tools = Object.freeze({
  call: async (action) => {
    const result = await call(JSON.stringify(action)).catch((failure) => {
      const details = JSON.parse(failure);
      const error = new Error(details.message);
      error.code = details.error;
      throw error;
    });
    if (result === undefined) return undefined;
    return JSON.parse(result);
  },
});
globalThis.tools = tools;
Promise.resolve()
  .then(() => import("program"))
  .then((namespace) => {
    if (mode === "function") return namespace.default({ tools, console });
    if (mode === "evaluate") return namespace.default;
    return null;
  })
  .then(
    (result) => {
      if (result !== undefined) output.result = result;
      finish(JSON.stringify(output));
    },
    (error) => {
      output.exitCode = 1;
      append("stderr", [String(error)]);
      finish(JSON.stringify(output));
    },
  );
