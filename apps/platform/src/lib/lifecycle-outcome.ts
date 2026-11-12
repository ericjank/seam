import type { AgentTurnResult } from "@seam/protocol";

/** Keep the original receipt in the job; select only its actionable outcome. */
export function normalizeLifecycleOutcome(turn: AgentTurnResult, revision: number): AgentTurnResult {
  if (turn.needsHumanInput || turn.actions.length === 0) return { ...turn, actions: [{
    type: "workflow.blocked", revision, kind: turn.needsHumanInput ? "needs_admin" : "retryable",
    reason: `${turn.needsHumanInput ? "执行端需要必要事实" : "执行端未提交本阶段成果，等待重试"}：${turn.message}`.slice(0, 5000),
    dependencyParticipantIds: [], retryAfterSeconds: 5,
  }] };
  const blocks = turn.actions.filter((action) => action.type === "workflow.blocked");
  // A not_run report explains why the agent is waiting. Applying it first
  // could finish the phase prematurely. Preserve it in the raw receipt and
  // apply the explicit wait. Never suppress passed or failed actual results.
  if (blocks.length === 1) return { ...turn, actions: turn.actions.filter((action) =>
    action.type !== "integration.report" || action.checks.some((check) => check.status !== "not_run")) };
  return turn;
}
