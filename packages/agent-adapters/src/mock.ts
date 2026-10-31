import type { AgentAdapter, AgentRunInput } from "./types";

export class MockAgentAdapter implements AgentAdapter {
  readonly type = "mock" as const;

  async run(input: AgentRunInput) {
    if (!input.context) {
      return { message: "Mock Agent 已收到消息。", kind: "chat" as const, actions: [], notifyParticipantIds: [], needsHumanInput: false };
    }
    const { context } = input;
    if (context.participant.role === "provider" && context.artifacts.length === 0) {
      return {
        message: "我先提供一份最小 OpenAPI 草案，请其他参与方检查路径和字段。",
        kind: "chat" as const,
        actions: [{
          type: "artifact.upsert" as const,
          title: `${context.title} API 契约`,
          artifactType: "openapi" as const,
          content: JSON.stringify({ openapi: "3.1.0", info: { title: context.title, version: "0.1.0" }, paths: { "/health": { get: { responses: { "200": { description: "OK" } } } } } }, null, 2),
        }],
        notifyParticipantIds: context.participants.filter((item) => item.id !== context.participant.id && item.status === "active").map((item) => item.id),
        needsHumanInput: false,
      };
    }
    if (context.workItems.length === 0 && context.artifacts.length > 0) {
      return {
        message: "契约草案已收到。我创建本项目的对接任务，完成后再提交真实测试证据。",
        kind: "status" as const,
        actions: [{ type: "work.create" as const, title: `${context.participant.projectName} 对接实施`, description: "按已确认的契约完成本地实现。", assigneeParticipantId: context.participant.id, priority: "normal" as const, acceptanceCriteria: "本地契约测试通过", dependsOn: [] }],
        notifyParticipantIds: [],
        needsHumanInput: false,
      };
    }
    return {
      message: `已同步当前协作状态：${context.artifacts.length} 个产物、${context.workItems.length} 个任务。暂不自动提交验收。`,
      kind: "status" as const, actions: [], notifyParticipantIds: [], needsHumanInput: false,
    };
  }

  async healthCheck() {
    return { ok: true, detail: "确定性 Mock Agent 可用" };
  }
}
