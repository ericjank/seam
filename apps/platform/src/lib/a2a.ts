import type { AgentCard } from "@a2a-js/sdk";

export function agentCard(agentId: string, name: string): AgentCard {
  const url = `${(process.env.SEAM_APP_URL ?? "http://localhost:3000").replace(/\/$/, "")}/api/a2a/${agentId}`;
  return {
    name, description: "Seam 私有项目 Agent，仅处理显式授权的协作消息。",
    protocolVersion: "0.3.0", version: "0.1.0", url,
    skills: [{ id: "collaborate", name: "项目协作", description: "多方协商、分工与验收", tags: ["collaboration"] }],
    capabilities: { streaming: false, pushNotifications: false },
    defaultInputModes: ["text", "data"], defaultOutputModes: ["text", "data"],
    additionalInterfaces: [{ url, transport: "JSONRPC" }],
  };
}
