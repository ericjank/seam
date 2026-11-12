import type { SharedContract } from "@seam/protocol";

/** Compare content by stable identity, including edits that keep the same ID. */
export function contractChanges(previous: SharedContract, current: SharedContract) {
  const entries = (contract: SharedContract) => new Map<string, string>([
    ["范围", contract.scope], ["风险", contract.risks], ["变更说明", contract.changeSummary],
    ["影响项目", contract.impactedParticipantIds.join("\n")], ["保留决定", contract.retainedDecisions.join("\n")],
    ...(contract.effectiveRequirements ?? []).map((item): [string, string] => [`要求 ${item.id}`, item.text]),
    ["本版撤销要求", (contract.retiredRequirements ?? []).map((item) => `${item.id}：${item.reason}`).join("\n")],
    ...(contract.serviceExpectations ?? []).map((item): [string, string] => [`就绪 ${item.publisherParticipantId}:${item.name}`, JSON.stringify(item, null, 2)]),
    ...contract.interfaces.map((item): [string, string] => [`接口 ${item.id}`, item.definition]),
    ...contract.responsibilities.map((item): [string, string] => [`职责 ${item.participantId}`, item.changes]),
    ...contract.acceptanceCases.map((item): [string, string] => [`用例 ${item.id}`, `${item.runnerParticipantId}\n${item.description}\n${item.command}\n${item.expectedResult}\n${item.requiredAssertions?.join("\n") ?? "历史用例未声明完整断言集"}`]),
  ]);
  const before = entries(previous), after = entries(current);
  return [...new Set([...before.keys(), ...after.keys()])].filter((key) => before.get(key) !== after.get(key)).map((key) => ({ key, before: before.get(key) ?? "（无）", after: after.get(key) ?? "（已移除）" }));
}
