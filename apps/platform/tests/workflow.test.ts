import { describe, expect, it } from "vitest";
import { nextWorkflowTargets, type Workflow } from "../src/lib/workflow";
import { agentTurnResultSchema } from "@seam/protocol";

const a = "b641fbcb-1ecd-4a56-b632-de40f536b624";
const b = "6bbaf593-c0c4-428b-8109-b5cb98aa643b";
const workflow: Workflow = { id: "run", round: 1, maxRounds: 3, autoAdvance: true };
function plan(overrides: Partial<Parameters<typeof nextWorkflowTargets>[0]> = {}) {
  return nextWorkflowTargets({
    workflow, turns: [{ participantId: a, turn: agentTurnResultSchema.parse({ message: "接口已更新" }), changed: true }],
    activeParticipantIds: [a, b], failed: false, completed: false, newInstruction: false, ...overrides,
  });
}

describe("有界自动协作", () => {
  it("有实质变化时自动通知对方，无需人工复制内容或UUID", () => expect(plan().targets).toEqual([b]));
  it("纯文字/无变化回执停止，避免反复空转", () => expect(plan({ turns: [{ participantId: a, turn: agentTurnResultSchema.parse({ message: "暂无变化" }), changed: false }] }).targets).toEqual([]));
  it("失败、需要人类输入、验收完成均不再派发", () => {
    expect(plan({ failed: true }).targets).toEqual([]);
    expect(plan({ completed: true }).targets).toEqual([]);
    expect(plan({ turns: [{ participantId: a, turn: agentTurnResultSchema.parse({ message: "需提供测试地址", needsHumanInput: true, notifyParticipantIds: [b] }), changed: true }] }).targets).toEqual([]);
  });
  it("一批多人回复不会给同一参与方重复派发", () => {
    const turn = agentTurnResultSchema.parse({ message: "继续", notifyParticipantIds: [a, b, b, "30dc5100-3073-4372-be93-32595b07188b"] });
    expect(plan({ turns: [{ participantId: a, turn, changed: true }, { participantId: b, turn, changed: true }] }).targets.sort()).toEqual([a, b].sort());
  });
  it("预算耗尽时停止，下一次明确发起可使用新预算", () => {
    expect(plan({ workflow: { ...workflow, round: 3 } }).reason).toContain("上限");
    expect(plan().targets).toEqual([b]);
  });
  it("执行期间补充的新指令仍会交给所有端", () => expect(plan({ turns: [], newInstruction: true }).targets).toEqual([a, b]));
  it("新答案不会被旧的人工问题、失败或用尽的预算吞掉", () => {
    expect(plan({ newInstruction: true, failed: true, workflow: { ...workflow, round: 3 }, turns: [{ participantId: a, turn: agentTurnResultSchema.parse({ message: "缺信息", needsHumanInput: true }), changed: false }] }).targets).toEqual([a, b]);
  });
  it("手动单轮仅保留AI显式通知，不自动广播", () => {
    expect(plan({ workflow: { ...workflow, autoAdvance: false } }).targets).toEqual([]);
  });
});
