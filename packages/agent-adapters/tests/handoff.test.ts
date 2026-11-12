import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { collaborationContextSchema, type CollaborationContext, type CollaborationMessage } from "@seam/protocol";
import { buildNativeHandoff, materializeHandoffResources, type HandoffCheckpoint } from "../src/handoff";
import { buildPrompt } from "../src/cli";
import type { AgentRunInput } from "../src/types";

const id = (value: number) => `00000000-0000-4000-8000-${String(value).padStart(12, "0")}`;
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const occurrences = (text: string, value: string) => text.split(value).length - 1;

function message(value: number, body: string): CollaborationMessage {
  return { id: id(value), participantId: null, authorType: "user", authorName: "本机合成用户", kind: "chat", body, metadata: {}, createdAt: "2026-11-12T00:00:00.000Z" };
}

function context(): CollaborationContext {
  const participant = { id: id(2), projectId: id(3), projectName: "handoff-consumer", agentId: null, agentName: null, role: "consumer", approvalRequired: true, status: "active" };
  return collaborationContextSchema.parse({
    jobId: id(4), collaborationId: id(1), title: "紧凑交接验证", type: "custom", status: "negotiating", objective: "保留独有目标 GOAL_SENTINEL，完成合成接口测试。",
    participant, participants: [participant], messages: [], artifacts: [], workItems: [],
    lifecycle: { revision: 1, phase: "planning", requirements: "独有本轮要求 REQUIREMENT_SENTINEL", document: null, documentHash: null, approvedHash: null, requiredParticipantIds: [participant.id], contributions: [], confirmations: [], reports: [], report: null },
  });
}

function input(value = context()): AgentRunInput {
  return { projectRoot: "/tmp/seam-handoff-synthetic-project", context: value, conversationMode: "persistent", localExecutionPolicy: "sandbox=read-only，approval=never" };
}

describe("Native human-readable handoff", () => {
  it("长资料变为可校验的私有资源，原文完整保留；重连恢复引用，篡改则拒绝调用", async () => {
    const directory = await mkdtemp(join(tmpdir(), "seam-handoff-resource-test-"));
    try {
      const value = context(), document = `# DOC_START\n${"接口完整语义和断言条件\n".repeat(2000)}DOC_END`;
      value.lifecycle = { ...value.lifecycle!, phase: "plan_confirmation", document, documentHash: digest(document) };
      const prepared = await materializeHandoffResources(input(value), directory);
      const handoff = buildNativeHandoff(prepared), resource = prepared.resources!.find((item) => item.key === "document")!;
      expect(handoff.prompt.length).toBeLessThan(5000); expect(handoff.prompt).not.toContain(document);
      expect(await readFile(resource.path, "utf8")).toBe(document); expect(resource.hash).toBe(digest(document));
      expect((await stat(resource.path)).mode & 0o777).toBe(0o600);
      expect(handoff.prompt).toContain(resource.path); expect(handoff.prompt).toContain(resource.hash);
      const cli = buildPrompt(prepared); expect(cli).toContain("回复协议文件："); expect(cli).toContain("协作上下文文件："); expect(cli).not.toContain('"properties"');
      const continuing = buildNativeHandoff(prepared, handoff.checkpoint); expect(continuing.prompt).not.toContain(resource.path);
      expect(buildNativeHandoff(prepared).prompt).toContain(resource.path);
      await writeFile(resource.path, "tampered document");
      await expect(materializeHandoffResources(input(value), directory)).rejects.toThrow("指纹不符");
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
  it("首轮保留窗口外旧指令与新指令，重复消息只交接一次；后续新增指示仍可见", () => {
    const value = context();
    const oldInstruction = message(10, "OLD_INSTRUCTION_SENTINEL：兼容原有字段，不能部署。");
    const recent = message(11, "RECENT_INSTRUCTION_SENTINEL：复用已有契约。");
    value.instructions = [oldInstruction, recent];
    value.messages = [recent];
    const first = buildNativeHandoff(input(value));
    expect(first.prompt).toContain(oldInstruction.body);
    expect(occurrences(first.prompt, recent.body)).toBe(1);
    const added = message(12, "NEW_INSTRUCTION_SENTINEL：新增错误边界测试。");
    const next = buildNativeHandoff(input({ ...value, jobId: id(5), instructions: [...value.instructions, added], messages: [added] }), first.checkpoint);
    expect(occurrences(next.prompt, added.body)).toBe(1);
    expect(next.prompt).toContain(oldInstruction.body);
    expect(next.prompt).toContain(value.objective);
    expect(next.prompt).toContain(value.lifecycle!.requirements);
    expect(next.prompt).toContain(id(5));
    expect(first.outputSchema).toBeTypeOf("object");
    expect(first.prompt).not.toContain('"properties"');
    expect(first.prompt).not.toContain("协作上下文：{");
  });

  it("完整共同文档不截断，已嵌入的双方计划只出现一次，未并入的修订仍交接", () => {
    const value = context();
    const contribution = "# ORIGINAL_CONTRIBUTION_SENTINEL\n本方实施、接口、测试与验收全部保留。";
    const amendment = "# PENDING_AMENDMENT_SENTINEL\n这是尚未包含在共同文档中的新修订。";
    const document = `# 完整共同方案\n${"完整原文不能截断。\n".repeat(700)}${contribution}\nDOCUMENT_END_SENTINEL`;
    value.lifecycle = { ...value.lifecycle!, phase: "plan_confirmation", document, documentHash: digest(document), contributions: [{ participantId: id(2), content: contribution }, { participantId: id(20), content: amendment }] };
    const first = buildNativeHandoff(input(value));
    expect(occurrences(first.prompt, document)).toBe(1);
    expect(occurrences(first.prompt, contribution)).toBe(1);
    expect(first.prompt).toContain(amendment);
    expect(first.prompt).toContain("DOCUMENT_END_SENTINEL");
    const execution = { ...value, jobId: id(5), lifecycle: { ...value.lifecycle, phase: "executing" as const, approvedHash: digest(document) } };
    const next = buildNativeHandoff(input(execution), first.checkpoint);
    expect(next.prompt).toContain(digest(document));
    expect(next.prompt).toContain("executing");
    expect(occurrences(next.prompt, document)).toBe(0);
    const samePhase = buildNativeHandoff(input({ ...execution, jobId: id(6) }), next.checkpoint);
    expect(occurrences(samePhase.prompt, document)).toBe(0);
  });

  it("无共同文档时保留完整各方计划，不能把未汇总计划当作重复信息省略", () => {
    const value = context();
    const plan = `# UNMERGED_PLAN_SENTINEL\n${"具体修改与双方接口保持原文。\n".repeat(80)}PLAN_END_SENTINEL`;
    value.lifecycle!.contributions = [{ participantId: id(2), content: plan }];
    expect(buildNativeHandoff(input(value)).prompt).toContain(plan);
  });

  it("同一消息ID的正文或附加信息变化会再次交接", () => {
    const value = context();
    value.messages = [message(10, "ORIGINAL_MESSAGE_SENTINEL")];
    const first = buildNativeHandoff(input(value));
    const edited = { ...value.messages[0]!, body: "EDITED_MESSAGE_SENTINEL", metadata: { scope: "UPDATED_METADATA_SENTINEL" } };
    const next = buildNativeHandoff(input({ ...value, messages: [edited] }), first.checkpoint);
    expect(next.prompt).toContain(edited.body);
    expect(next.prompt).toContain("UPDATED_METADATA_SENTINEL");
    expect(next.prompt).not.toContain("ORIGINAL_MESSAGE_SENTINEL");
  });

  const resources: Array<{ key: "artifacts" | "workItems" | "proposals" | "credentialRequests" | "acceptanceRuns"; original: unknown; updated: unknown }> = [
    { key: "artifacts", original: { id: id(30), title: "原始产物", type: "markdown", currentVersion: 1, versions: [{ id: id(31), artifactId: id(30), version: 1, content: "RESOURCE_ORIGINAL_SENTINEL", contentHash: "a".repeat(64), createdByParticipantId: null, createdAt: "2026-11-12T00:00:00.000Z" }] }, updated: { id: id(30), title: "更新产物", type: "markdown", currentVersion: 1, versions: [{ id: id(31), artifactId: id(30), version: 1, content: "RESOURCE_UPDATED_SENTINEL", contentHash: "b".repeat(64), createdByParticipantId: null, createdAt: "2026-11-12T00:00:00.000Z" }] } },
    { key: "workItems", original: { id: id(40), title: "RESOURCE_ORIGINAL_SENTINEL", assigneeParticipantId: null, status: "pending", priority: "normal" }, updated: { id: id(40), title: "RESOURCE_UPDATED_SENTINEL", assigneeParticipantId: null, status: "blocked", priority: "normal" } },
    { key: "proposals", original: { id: id(50), title: "提案", body: "RESOURCE_ORIGINAL_SENTINEL", status: "open", artifactVersionId: null, approvalMode: "required", approvals: [] }, updated: { id: id(50), title: "提案", body: "RESOURCE_UPDATED_SENTINEL", status: "accepted", artifactVersionId: null, approvalMode: "required", approvals: [] } },
    { key: "credentialRequests", original: { id: id(60), ownerParticipantId: id(2), recipientParticipantId: id(20), name: "合成凭据状态", type: "api-token", environment: "test", purpose: "RESOURCE_ORIGINAL_SENTINEL", status: "requested", expiresAt: null }, updated: { id: id(60), ownerParticipantId: id(2), recipientParticipantId: id(20), name: "合成凭据状态", type: "api-token", environment: "test", purpose: "RESOURCE_UPDATED_SENTINEL", status: "revoked", expiresAt: null } },
    { key: "acceptanceRuns", original: { id: id(70), workItemId: null, participantId: id(2), artifactVersionId: null, status: "failed", summary: "RESOURCE_ORIGINAL_SENTINEL", evidence: { exitCode: 1 }, createdAt: "2026-11-12T00:00:00.000Z" }, updated: { id: id(70), workItemId: null, participantId: id(2), artifactVersionId: null, status: "passed", summary: "RESOURCE_UPDATED_SENTINEL", evidence: { exitCode: 0 }, createdAt: "2026-11-12T00:00:00.000Z" } },
  ];

  it.each(resources)("$key 同ID内容变化与移除均明确交接，避免线程沿用旧资源", ({ key, original, updated }) => {
    const value = collaborationContextSchema.parse({ ...context(), [key]: [original] });
    const first = buildNativeHandoff(input(value));
    expect(first.prompt).toContain("RESOURCE_ORIGINAL_SENTINEL");
    const changed = collaborationContextSchema.parse({ ...value, [key]: [updated] });
    const second = buildNativeHandoff(input(changed), first.checkpoint);
    expect(second.prompt).toContain("RESOURCE_UPDATED_SENTINEL");
    const removed = collaborationContextSchema.parse({ ...changed, [key]: [] });
    const third = buildNativeHandoff(input(removed), second.checkpoint);
    expect(third.prompt).not.toContain("RESOURCE_UPDATED_SENTINEL");
    expect(third.prompt).toMatch(/当前为空|不再适用|no longer|now empty/iu);
  });

  it("显示文本相同但证据值类型变化仍交接，不能把布尔值true和字符串true视为未变", () => {
    const value = collaborationContextSchema.parse({ ...context(), acceptanceRuns: [{
      id: id(70), workItemId: null, participantId: id(2), artifactVersionId: null, status: "passed", summary: "SEMANTIC_TYPE_CHANGE_SENTINEL", evidence: { result: true }, createdAt: "2026-11-12T00:00:00.000Z",
    }] });
    const first = buildNativeHandoff(input(value));
    const changed = { ...value, acceptanceRuns: [{ ...value.acceptanceRuns[0]!, evidence: { result: "true" } }] };
    const second = buildNativeHandoff(input(changed), first.checkpoint);
    expect(second.prompt).toContain("SEMANTIC_TYPE_CHANGE_SENTINEL");
  });

  it("同scope新修订交接新要求并显式清除旧文档与批准，不必重复全部旧消息", () => {
    const value = context();
    const document = "OLD_DOCUMENT_SENTINEL：这是上一轮批准的完整文档。";
    value.lifecycle = { ...value.lifecycle!, phase: "executing", document, documentHash: digest(document), approvedHash: digest(document) };
    value.instructions = [message(10, "OLD_USER_CONSTRAINT_SENTINEL：不得部署。")];
    const first = buildNativeHandoff(input(value));
    const revised = { ...value, jobId: id(5), lifecycle: { ...value.lifecycle, revision: 2, phase: "planning" as const, requirements: "NEW_REVISION_REQUIREMENT_SENTINEL：补充折扣测试。", document: null, documentHash: null, approvedHash: null } };
    const next = buildNativeHandoff(input(revised), first.checkpoint);
    expect(next.prompt).toContain(revised.lifecycle.requirements);
    expect(next.prompt).toContain("planning");
    expect(next.prompt).toMatch(/(?:修订|revision)[^\n]*2/iu);
    expect(next.prompt).toMatch(/documentHash[^\n]*(?:无|null|none)/iu);
    expect(next.prompt).toMatch(/approvedHash[^\n]*(?:未批准|无|null|none)/iu);
    expect(next.prompt).toMatch(/当前为空|不再适用|no longer|now empty/iu);
    expect(next.prompt).not.toContain(document);
    expect(next.prompt).toContain(value.instructions[0]!.body);
  });

  it("更换协作或参与方、无效版本或校验点恢复完整交接，旧指令不依赖另一线程", () => {
    const value = context();
    value.instructions = [message(10, "RESET_REQUIRES_OLD_INSTRUCTION_SENTINEL")];
    const first = buildNativeHandoff(input(value));
    const variants: Array<{ value: CollaborationContext; previous: HandoffCheckpoint }> = [
      { value: { ...value, collaborationId: id(90) }, previous: first.checkpoint },
      { value: { ...value, participant: { ...value.participant, id: id(91) } }, previous: first.checkpoint },
      { value, previous: { ...first.checkpoint, version: first.checkpoint.version + 1 } as HandoffCheckpoint },
      { value, previous: { ...first.checkpoint, sections: { goal: "invalid-hash" } } },
    ];
    for (const variant of variants) {
      const next = buildNativeHandoff(input(variant.value), variant.previous);
      expect(next.prompt).toContain(value.objective);
      expect(next.prompt).toContain(value.instructions[0]!.body);
      expect(next.prompt).toContain(value.lifecycle!.requirements);
    }
  });
});
