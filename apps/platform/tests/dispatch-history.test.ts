import { describe, expect, it } from "vitest";
import { dispatchMessage, recoverDispatchNames, type DispatchJob } from "../src/lib/dispatch-message";

const job = (id: string, name: string, second: number): DispatchJob => ({ jobId: id, workflowId: `workflow-${id}`, round: 1, maxRounds: 12,
  participantId: `participant-${id}`, projectId: `project-${id}`, projectName: "同名项目", agentId: `agent-${id}`, agentName: name, createdAt: new Date(second * 1000) });
const message = (second: number) => ({ authorType: "system", body: "已向 1 个项目 Agent 派发本次第 1/12 批协作。", metadata: {}, createdAt: new Date(second * 1000) });

describe("历史派发对象溯源", () => {
  it("跨流程重复批号按实际任务顺序恢复Agent名，已有派发快照和原存储正文保持原样", () => {
    const jobs = [job("a", "提供方 Codex", 1), job("b", "消费方 Codex", 3), job("c", "之后改名的Agent", 5)];
    const dispatch = { workflowId: jobs[2]!.workflowId, round: 1, maxRounds: 12, targets: [{ ...jobs[2]!, agentName: "派发时的名称" }] };
    const messages = [message(2), message(4), { ...message(6), body: dispatchMessage(dispatch), metadata: { dispatch } }];
    const resolved = recoverDispatchNames(messages, jobs);
    expect(resolved[0]!.body).toContain("Agent「提供方 Codex」");
    expect(resolved[0]!.body).not.toContain("消费方 Codex");
    expect(resolved[1]!.body).toContain("Agent「消费方 Codex」");
    expect(resolved[2]).toBe(messages[2]);
    expect(resolved[2]!.body).toContain("派发时的名称");
    expect(messages[0]!.body).toBe("已向 1 个项目 Agent 派发本次第 1/12 批协作。");
  });

  it("记录缺失、数量不符、时间倒置或已有任务标识冲突时不猜测接收方", () => {
    const jobs = [job("a", "提供方", 1), job("b", "消费方", 3)], messages = [message(2), message(4)];
    expect(recoverDispatchNames(messages, jobs.slice(1))).toBe(messages);
    expect(recoverDispatchNames(messages, [{ ...jobs[0]!, round: 2 }, jobs[1]!])).toBe(messages);
    expect(recoverDispatchNames(messages, [{ ...jobs[0]!, createdAt: new Date(10_000) }, jobs[1]!])).toBe(messages);
    const conflicting = [messages[0]!, { ...messages[1]!, body: "已派发协作", metadata: { dispatch: { workflowId: jobs[1]!.workflowId, round: 1, maxRounds: 12, targets: [{ ...jobs[1]!, jobId: "another-job" }] } } }];
    expect(recoverDispatchNames(conflicting, jobs)).toBe(conflicting);
  });
});
