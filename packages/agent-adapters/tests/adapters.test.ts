import { describe, expect, it } from "vitest";
import { MockAgentAdapter, parseAgentOutput } from "../src/index";

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
});
