import type { AgentTurnResult } from "@seam/protocol";

export type Workflow = {
  id: string;
  round: number;
  maxRounds: number;
  autoAdvance: boolean;
  inputMessageId?: string;
};

export function nextWorkflowTargets(input: {
  workflow: Workflow;
  turns: Array<{ participantId: string; turn: AgentTurnResult; changed: boolean }>;
  activeParticipantIds: string[];
  failed: boolean;
  completed: boolean;
  newInstruction: boolean;
}): { targets: string[]; reason?: string } {
  // A reply sent during execution must not be swallowed by an older "needs input"
  // result or an exhausted budget. It starts a fresh, bounded request.
  if (input.newInstruction) return { targets: input.activeParticipantIds };
  if (input.failed) return { targets: [], reason: "本批执行失败，请先查看任务错误并修复，再继续推进。" };
  if (input.turns.some(({ turn }) => turn.needsHumanInput)) return { targets: [], reason: "Agent 需要你补充信息，回复后会继续推进。" };
  if (input.completed) return { targets: [], reason: "协作已完成，自动推进已停止。" };
  const targets = new Set(input.turns.flatMap(({ turn }) => turn.notifyParticipantIds));
  if (input.workflow.autoAdvance) {
    for (const source of input.turns) {
      if (!source.changed) continue;
      input.activeParticipantIds.filter((id) => id !== source.participantId).forEach((id) => targets.add(id));
    }
  }
  const eligible = [...targets].filter((id) => input.activeParticipantIds.includes(id));
  if (!eligible.length) return { targets: [], reason: "本批没有新的交接事项，已暂停自动推进；可补充目标或点击继续推进。" };
  if (input.workflow.round >= input.workflow.maxRounds) return { targets: [], reason: `本次已达到 ${input.workflow.maxRounds} 批自动推进上限；可检查结果后继续推进。` };
  return { targets: eligible };
}
