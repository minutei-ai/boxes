declare const run: (context: {
  tools: { call(action: unknown): Promise<unknown> };
  console: Pick<Console, "log" | "error">;
}) => Promise<unknown>;
export default run;
