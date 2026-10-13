export default {
  async fetch(
    _request: Request,
    env: { TOOLS: { call(action: unknown): Promise<unknown> }; MAX_OUTPUT: number },
  ) {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const output = { size: 0, overflow: false };
    const emit = (target: string[], values: unknown[]) => {
      const line = `${values.map(String).join(" ")}\n`;
      output.size += new TextEncoder().encode(line).byteLength;
      if (output.size > env.MAX_OUTPUT) {
        output.overflow = true;
        return;
      }
      target.push(line);
    };
    globalThis.console.log = (...values: unknown[]) => emit(stdout, values);
    globalThis.console.info = (...values: unknown[]) => emit(stdout, values);
    globalThis.console.debug = (...values: unknown[]) => emit(stdout, values);
    globalThis.console.error = (...values: unknown[]) => emit(stderr, values);
    globalThis.console.warn = (...values: unknown[]) => emit(stderr, values);
    const run = (await import("./program.js")).default;
    const result = await run({ tools: env.TOOLS, console: globalThis.console });
    if (output.overflow) return new Response("Guest output exceeded its limit", { status: 413 });
    if (result === undefined)
      return Response.json({
        stdout: stdout.join(""),
        stderr: stderr.join(""),
        result: null,
        exitCode: 0,
      });
    return Response.json({ stdout: stdout.join(""), stderr: stderr.join(""), result, exitCode: 0 });
  },
};
