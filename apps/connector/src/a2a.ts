import { randomUUID } from "node:crypto";
import type { AgentCard, Message } from "@a2a-js/sdk";
import {
  DefaultRequestHandler,
  InMemoryTaskStore,
  JsonRpcTransportHandler,
  type AgentExecutor,
  type ExecutionEventBus,
  type RequestContext,
} from "@a2a-js/sdk/server";
import type { AgentAdapter } from "@seam/agent-adapters";

export function createA2AHandler(adapter: AgentAdapter, projectRoot: string, agentName: string, agentUrl: string) {
  const card: AgentCard = {
    name: agentName,
    description: "Seam 私有项目协作 Agent",
    protocolVersion: "0.3.0",
    version: "0.1.0",
    url: agentUrl,
    skills: [
      { id: "collaborate", name: "多方项目协作", description: "协商、分工与验收", tags: ["collaboration", "software"] },
      { id: "api-integration", name: "接口对接", description: "接口契约协商与联调", tags: ["api", "integration"] },
    ],
    capabilities: { pushNotifications: false, streaming: false },
    defaultInputModes: ["text", "data"],
    defaultOutputModes: ["text", "data"],
    additionalInterfaces: [{ url: agentUrl, transport: "JSONRPC" }],
  };
  const executor: AgentExecutor = {
    async execute(requestContext: RequestContext, eventBus: ExecutionEventBus) {
      const prompt = requestContext.userMessage.parts.map((part) => {
        if (part.kind === "text") return part.text;
        if (part.kind === "data") return JSON.stringify(part.data);
        return "[文件内容已由本地 A2A 策略忽略]";
      }).join("\n");
      const result = await adapter.run({ prompt, projectRoot });
      const response: Message = {
        kind: "message",
        messageId: randomUUID(),
        role: "agent",
        parts: [
          { kind: "text", text: result.message },
          { kind: "data", data: { actions: result.actions, needsHumanInput: result.needsHumanInput } },
        ],
      };
      eventBus.publish(response);
      eventBus.finished();
    },
    async cancelTask() {},
  };
  const requestHandler = new DefaultRequestHandler(card, new InMemoryTaskStore(), executor);
  return { card, requestHandler, transport: new JsonRpcTransportHandler(requestHandler) };
}
