import { describe, expect, it } from "vitest";
import { agentTurnResultSchema, collaborationContextSchema } from "@seam/protocol";
import { buildNativeOutputSchema, parseNativeAgentOutput } from "../src/response-schema";
import type { AgentRunInput } from "../src/types";

function input(phase = "planning"): AgentRunInput {
  return { projectRoot: "/private/isolated", context: collaborationContextSchema.parse({
    collaborationId: crypto.randomUUID(), title: "结构化交接", type: "custom", status: "negotiating", objective: "测试",
    participant: { id: crypto.randomUUID(), projectId: crypto.randomUUID(), projectName: "本方", agentId: null, agentName: null, role: "participant", approvalRequired: true, status: "active" },
    participants: [], messages: [], artifacts: [], workItems: [],
    lifecycle: { revision: 4, phase, requirements: "合成", document: "共同方案", documentHash: "a".repeat(64), approvedHash: null, requiredParticipantIds: [], contributions: [], confirmations: [], reports: [], report: null },
  }) };
}
const reply = (actions: unknown[] = []) => ({ message: "已根据本轮实际状态交接。", kind: "status", actions, notifyParticipantIds: [], needsHumanInput: false });
const parse = (actions: unknown[], value = input()) => parseNativeAgentOutput(JSON.stringify(reply(actions)), value);

function inspectStrictObjects(value: unknown) {
  if (Array.isArray(value)) { value.forEach(inspectStrictObjects); return; }
  if (!value || typeof value !== "object") return;
  const schema = value as Record<string, unknown>;
  expect(schema).not.toHaveProperty("default");
  if (schema.type === "object") {
    expect(schema.additionalProperties).toBe(false);
    expect(schema.required ?? []).toEqual(Object.keys(schema.properties as object));
  }
  if (schema.format === "uuid") expect(schema).not.toHaveProperty("pattern");
  Object.values(schema).forEach(inspectStrictObjects);
}

describe("Native response schema", () => {
  it("每阶段生成全required、closed object的结构，避免default与开放record", () => {
    for (const phase of ["planning", "plan_confirmation", "executing", "awaiting_approval", "awaiting_review", "terminated"]) {
      const schema = buildNativeOutputSchema(input(phase));
      inspectStrictObjects(schema);
      expect(schema).not.toHaveProperty("$schema");
      expect(Object.keys(schema.properties as object)).toEqual(["message", "kind", "actions", "notifyParticipantIds", "needsHumanInput"]);
    }
    const planning = JSON.stringify(buildNativeOutputSchema(input()));
    expect(planning).toContain('"const":"plan.submit"');
    expect(planning).toContain('"const":4');
    expect(planning).not.toContain("execution.report");
    expect(planning).not.toContain("proposal.decide");
    const executing = JSON.stringify(buildNativeOutputSchema(input("executing")));
    expect(executing).toContain("execution.report");
    expect(executing).toContain("artifact.upsert");
    expect(executing).not.toContain("plan.confirm");
  });

  it("确认只能使用当轮revision/hash，仍可提交修订且不自动产生批准", () => {
    const value = input("plan_confirmation");
    const confirm = { type: "plan.confirm", revision: 4, documentHash: "a".repeat(64) };
    expect(parse([confirm], value).actions).toEqual([confirm]);
    expect(() => parse([{ ...confirm, revision: 3 }], value)).toThrow("revision/documentHash");
    expect(() => parse([{ ...confirm, documentHash: "b".repeat(64) }], value)).toThrow("revision/documentHash");
    expect(parse([{ type: "plan.submit", revision: 4, content: "修订说明".repeat(40) }], value).actions[0]?.type).toBe("plan.submit");
    value.context!.lifecycle!.documentHash = null;
    expect(() => parse([confirm], value)).toThrow("当前阶段");
  });

  it("拒绝纯文本/围栏/缺失字段和越阶段动作，不降级成成功聊天", () => {
    for (const text of ["全部完成", `\`\`\`json\n${JSON.stringify(reply())}\n\`\`\``, JSON.stringify({ message: "字段不完整" })]) {
      expect(() => parseNativeAgentOutput(text, input())).toThrow("未发布本轮结果");
    }
    const report = { type: "execution.report", revision: 4, status: "passed", summary: "已测试", evidence: { details: "node --test: exit 0" } };
    expect(() => parse([report])).toThrow("当前阶段");
    for (const phase of ["awaiting_approval", "awaiting_review", "terminated"]) {
      expect(parse([], input(phase)).actions).toEqual([]);
      expect(() => parse([report], input(phase))).toThrow("当前阶段");
    }
  });

  it("执行辅助动作nullable仅用于缺省ID，evidence固定details并兼容公共协议", () => {
    const actions = [
      { type: "execution.report", revision: 4, status: "failed", summary: "实际受本地策略阻塞", evidence: { details: "未执行测试；仍缺本机写入授权。" } },
      { type: "artifact.upsert", artifactId: null, title: "结果", artifactType: "test-report", content: "实际证据摘要" },
      { type: "work.update", workItemId: crypto.randomUUID(), status: null, summary: null },
      { type: "acceptance.submit", workItemId: null, artifactId: null, status: "failed", summary: "尚未验收", evidence: { details: "本次未运行。" } },
    ];
    const result = parse(actions, input("executing"));
    expect(result.actions[1]).not.toHaveProperty("artifactId");
    expect(result.actions[2]).not.toHaveProperty("status");
    expect(result.actions[2]).not.toHaveProperty("summary");
    expect(result.actions[3]).not.toHaveProperty("workItemId");
    expect(agentTurnResultSchema.parse(result)).toEqual(result);
    expect(() => parse([{ ...actions[0], revision: 3 }], input("executing"))).toThrow("revision/documentHash");
    expect(() => parse([{ ...actions[0], evidence: { details: "真实信息", arbitrarySecret: "禁止额外数据" } }], input("executing"))).toThrow("未发布");
    expect(() => parse([{ ...actions[2], workItemId: "uuid校验仍在本地执行" }], input("executing"))).toThrow("未发布");
  });

  it("无lifecycle保持legacy交接范围，不引入方案确认或执行批准", () => {
    const value = input();
    value.context!.lifecycle = null;
    const schema = buildNativeOutputSchema(value);
    inspectStrictObjects(schema);
    expect(JSON.stringify(schema)).toContain("proposal.create");
    expect(JSON.stringify(schema)).not.toContain("plan.confirm");
    const result = parse([{ type: "artifact.upsert", artifactId: null, title: "契约", artifactType: "markdown", content: "只读分析" }], value);
    expect(result.actions[0]?.type).toBe("artifact.upsert");
  });
});
