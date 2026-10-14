import { WorkerEntrypoint, type RpcStub } from "cloudflare:workers";
import type { AgentReply, AgentRequest, HostCall, HostReply } from "./contracts";

export type HostCallback = (request: typeof HostCall.Encoded) => Promise<typeof HostReply.Encoded>;

export abstract class AgentProtocol<Env = unknown> extends WorkerEntrypoint<Env> {
  abstract runWithTools(
    request: typeof AgentRequest.Encoded,
    callback: RpcStub<HostCallback>,
  ): Promise<typeof AgentReply.Encoded>;
}
