import { describe, expect, it } from "vitest";
import { MockAgentAdapter, parseAgentOutput } from "../src/index";
import { collaborationContextSchema } from "@seam/protocol";

describe("Agent 适配器", () => {
  it("解析 Claude JSON 包装", () => {
    const result = parseAgentOutput(JSON.stringify({ result: JSON.stringify({ message: "同意", actions: [] }) }));
    expect(result.message).toBe("同意");
  });

  it("非结构化文本不会静默变成验收", () => {
    const result = parseAgentOutput("我已经完成全部工作");
    expect(result.actions).toEqual([]);
  });

  it("Mock 提供方只发布契约而不上传源码", async () => {
    const adapter = new MockAgentAdapter();
    const result = await adapter.run({
      projectRoot: "/private/project",
      context: {
        collaborationId: crypto.randomUUID(), title: "测试", type: "api-integration", status: "draft", objective: "验证",
        participant: { id: crypto.randomUUID(), projectId: crypto.randomUUID(), projectName: "提供方", agentId: null, agentName: null, role: "provider", approvalRequired: true, status: "active" },
        participants: [], messages: [], artifacts: [], workItems: [],
      },
    });
    expect(result.actions[0]?.type).toBe("artifact.upsert");
    expect(JSON.stringify(result)).not.toContain("/private/project");
  });

  it("Mock 消费方在别人已有任务时仍创建本方任务，本方已有任务时不重复", async () => {
    const participantId = crypto.randomUUID();
    const otherId = crypto.randomUUID();
    const context = collaborationContextSchema.parse({
      collaborationId: crypto.randomUUID(), title: "三方协作", type: "api-integration", status: "negotiating", objective: "每个消费方独立实施",
      participant: { id: participantId, projectId: crypto.randomUUID(), projectName: "消费方二", agentId: null, agentName: null, role: "consumer", approvalRequired: true, status: "active" },
      participants: [], messages: [],
      artifacts: [{ id: crypto.randomUUID(), title: "共享契约", type: "openapi", currentVersion: 1 }],
      workItems: [{ id: crypto.randomUUID(), title: "消费方一任务", assigneeParticipantId: otherId, status: "in_progress", priority: "normal" }],
    });
    const adapter = new MockAgentAdapter();
    const first = await adapter.run({ projectRoot: "/private/project", context });
    expect(first.actions).toEqual([expect.objectContaining({ type: "work.create", assigneeParticipantId: participantId })]);
    context.workItems.push({ id: crypto.randomUUID(), title: "消费方二任务", description: "", assigneeParticipantId: participantId, status: "pending", priority: "normal", acceptanceCriteria: "", dependsOn: [] });
    const repeated = await adapter.run({ projectRoot: "/private/project", context });
    expect(repeated.actions).toEqual([]);
  });
});
