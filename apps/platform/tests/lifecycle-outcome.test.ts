import { describe, expect, it } from "vitest";
import { agentTurnResultSchema } from "@seam/protocol";
import { normalizeLifecycleOutcome } from "../src/lib/lifecycle-outcome";

const blocked = { type: "workflow.blocked", revision: 2, kind: "waiting_peer", reason: "当前真实服务不可达，等待提供方恢复。", dependencyParticipantIds: [], retryAfterSeconds: 5 };
describe("受控阶段回执的阻塞收敛", () => {
  it("明确的本机授权阻塞保留标记，不被needsHumanInput改写成普通缺失事实",()=>{
    const turn=agentTurnResultSchema.parse({message:"需本机维护者授予写入权限",needsHumanInput:true,actions:[{...blocked,kind:"needs_admin",requiresAuthorization:true}]});
    expect(normalizeLifecycleOutcome(turn,2).actions).toEqual(turn.actions);
  });
  it("needsHumanInput转为必要事实，缺成果转有界临时重试", () => {
    const turn = agentTurnResultSchema.parse({ message: "当前等待明确配置事实", actions: [], needsHumanInput: true });
    expect(normalizeLifecycleOutcome(turn, 2).actions[0]).toMatchObject({ type: "workflow.blocked", kind: "needs_admin", revision: 2 });
    expect(normalizeLifecycleOutcome({ ...turn, needsHumanInput: false }, 2).actions[0]).toMatchObject({ type: "workflow.blocked", kind: "retryable" });
    expect(turn.actions).toEqual([]);
  });
  it.each(["not_run", "failed", "passed"])("同时解释联合结果 %s 与等待时，只合并未执行说明", (status) => {
    const turn = agentTurnResultSchema.parse({ message: "实际联合结果与当前等待原因", actions: [
      { type: "integration.report", revision: 2, documentHash: "a".repeat(64), checks: [{ caseId: "quote", status, command: "node --test joint.test.mjs", summary: "当前服务状态", evidence: {} }] }, blocked,
    ] });
    const result = normalizeLifecycleOutcome(turn, 2);
    expect(result.actions).toHaveLength(status === "passed" ? 2 : 1);
    expect(result.actions.at(-1)).toMatchObject(status === "failed" ? {type:"integration.report"} : blocked);
    expect(turn.actions).toHaveLength(2); // The original job receipt remains intact.
  });
});
