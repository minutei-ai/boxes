import { Schema, Struct } from "effect";
import { AgentRequest, FileContent, HostCall, RunRecord } from "../../src/contracts";
import { publishedInterpreterCases } from "./published-software";
import { ShellCwdProof } from "./shell-cwd-proof";

export const remoteRpcTimeoutMs = 15000;
export const remoteDeadlinePath = "/deadline-observed";

export const RemoteBindingInput = AgentRequest.mapFields((fields) =>
  Struct.pick(fields, ["sandboxId", "token"]),
);
export const RemoteBindingProof = Schema.Struct({
  measuredAt: Schema.Int,
  callback: RunRecord,
  voidCallback: RunRecord,
  interpreters: Schema.Array(RunRecord).check(
    Schema.isMinLength(publishedInterpreterCases.length),
    Schema.isMaxLength(publishedInterpreterCases.length),
  ),
  interpreterFile: FileContent,
  shellCwd: ShellCwdProof,
  file: FileContent,
  calls: Schema.Array(HostCall),
  managementDenied: Schema.Int,
  wrongSandboxDenied: Schema.Int,
});
const CallbackValue = Schema.Struct({
  answer: Schema.Literal(42),
  transport: Schema.Literal("native RPC"),
});
const VoidValue = Schema.Struct({
  wasUndefined: Schema.Literal(true),
  freshGlobals: Schema.Literal(true),
});
export const VerifiedRemoteBindingProof = RemoteBindingProof.check(
  Schema.makeFilter(
    (proof) =>
      proof.interpreters.every(
        (run, index) =>
          run.status === "exited" &&
          run.output?.exitCode === 0 &&
          run.output.stderr === "" &&
          run.output.stdout === publishedInterpreterCases[index]?.stdout,
      ) &&
      Buffer.from(proof.interpreterFile.content, proof.interpreterFile.encoding).toString(
        "utf8",
      ) === publishedInterpreterCases.at(-1)?.id,
  ),
  Schema.makeFilter(
    (proof) =>
      proof.callback.status === "exited" &&
      proof.callback.output?.exitCode === 0 &&
      Schema.is(CallbackValue)(proof.callback.output.result) &&
      proof.voidCallback.status === "exited" &&
      proof.voidCallback.output?.exitCode === 0 &&
      Schema.is(VoidValue)(proof.voidCallback.output.result),
  ),
  Schema.makeFilter(
    (proof) =>
      proof.managementDenied === 403 &&
      proof.wrongSandboxDenied === 401 &&
      Buffer.from(proof.file.content, proof.file.encoding).toString() ===
        "native Cloudflare binding" &&
      proof.calls.length === 2 &&
      proof.calls[0]?.name === "answer" &&
      Schema.is(Schema.Struct({ value: Schema.Literal(21) }))(proof.calls[0]?.input) &&
      proof.calls[1]?.name === "void" &&
      proof.calls[1]?.input === undefined,
  ),
);
