import type { SharedContract } from "@seam/protocol";

/** Compare content by stable identity, including edits that keep the same ID. */
export function contractChanges(previous: SharedContract, current: SharedContract) {
  const entries = (contract: SharedContract) => new Map<string, string>([
    ["范围", contract.scope], ["风险", contract.risks], ["变更说明", contract.changeSummary],
    ["影响项目", contract.impactedParticipantIds.join("\n")], ["保留决定", contract.retainedDecisions.join("\n")],
    ...contract.interfaces.map((item): [string, string] => [`接口 ${item.id}`, item.definition]),
    ...contract.responsibilities.map((item): [string, string] => [`职责 ${item.participantId}`, item.changes]),
    ...contract.acceptanceCases.map((item): [string, string] => [`用例 ${item.id}`, `${item.runnerParticipantId}\n${item.description}\n${item.command}\n${item.expectedResult}`]),
  ]);
  const before = entries(previous), after = entries(current);
  return [...new Set([...before.keys(), ...after.keys()])].filter((key) => before.get(key) !== after.get(key)).map((key) => ({ key, before: before.get(key) ?? "（无）", after: after.get(key) ?? "（已移除）" }));
}
