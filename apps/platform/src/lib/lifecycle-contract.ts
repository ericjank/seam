import type { LifecycleContext, SharedContract } from "@seam/protocol";
import { HttpError } from "./http";

export function validateSharedContract(contract: SharedContract, required: string[]) {
  const unique = (values: string[]) => new Set(values).size === values.length;
  const owners = contract.responsibilities.map((item) => item.participantId);
  if (!unique(owners) || owners.length !== required.length || required.some((id) => !owners.includes(id))) throw new HttpError(422, "统一契约必须且只能包含每个指定参与方的一份责任划分");
  if (!unique(contract.interfaces.map((item) => item.id)) || !unique(contract.acceptanceCases.map((item) => item.id))) throw new HttpError(422, "接口及验收用例 ID 不得重复");
  if (contract.acceptanceCases.some((item) => !required.includes(item.runnerParticipantId)) || required.some((id) => !contract.acceptanceCases.some((item) => item.runnerParticipantId === id))) throw new HttpError(422, "联合验收必须覆盖每个参与方，执行方必须属于当前协作");
  if (!unique(contract.impactedParticipantIds) || contract.impactedParticipantIds.some((id) => !required.includes(id))) throw new HttpError(422, "影响范围包含无效或重复的参与方");
}

export function contractChanges(previous: SharedContract | null | undefined, current: SharedContract) {
  if (!previous) return ["首次形成统一契约，全部接口、职责与验收用例需审阅。"];
  const changes: string[] = [];
  for (const [key, label] of [["interfaces", "接口"], ["responsibilities", "项目职责"], ["acceptanceCases", "联合验收用例"]] as const) {
    const identity = (row: { id?: string; participantId?: string }) => row.id ?? row.participantId;
    for (const row of current[key]) {
      const before = previous[key].find((item) => identity(item) === identity(row));
      if (!before || JSON.stringify(before) !== JSON.stringify(row)) changes.push(`${label} ${identity(row)}：${before ? "修改" : "新增"}`);
    }
    for (const row of previous[key]) if (!current[key].some((item) => identity(item) === identity(row))) changes.push(`${label} ${identity(row)}：删除`);
  }
  if (previous.scope !== current.scope) changes.push("目标与实施范围已修改");
  if (previous.risks !== current.risks) changes.push("风险与运行约束已修改");
  return changes.length ? changes : ["接口、职责和用例保持一致；请核对本轮新增要求及变更说明。"];
}

export function renderSharedContract(input: {
  title: string; revision: number; requirements: string; changeRequest: string | null;
  contract: SharedContract; previous?: SharedContract | null;
  names: Map<string, string>; baselines: LifecycleContext["contributions"];
}) {
  const c = input.contract;
  const name = (id: string) => `${input.names.get(id) ?? id}（${id}）`;
  return [
    `# ${input.title}：统一开发对接实施文档（第 ${input.revision} 版）`,
    `## 目标与累计要求\n\n${input.requirements}`,
    `## 本轮变更与影响\n\n${input.changeRequest ?? "首次实施"}\n\n${c.changeSummary}\n\n影响项目：${c.impactedParticipantIds.map(name).join("、")}\n\n${contractChanges(input.previous, c).map((line) => `- ${line}`).join("\n")}`,
    `## 复用的既有决定\n\n${c.retainedDecisions.map((line) => `- ${line}`).join("\n") || "无"}\n\n历史测试只作参考，本轮仍须提交实际实施及联合验收结果。`,
    `## 实施范围\n\n${c.scope}`,
    `## 唯一接口契约\n\n${c.interfaces.map((item) => `### ${item.id}\n\n${item.definition}`).join("\n\n")}`,
    `## 项目责任与实施步骤\n\n${c.responsibilities.map((item) => `### ${name(item.participantId)}\n\n${item.changes}`).join("\n\n")}`,
    `## 联合验收\n\n${c.acceptanceCases.map((item) => `### ${item.id} · ${name(item.runnerParticipantId)}\n\n${item.description}\n\n执行命令：${item.command}\n\n预期：${item.expectedResult}`).join("\n\n")}\n\n命令由本机 Agent 按本地权限核对执行，平台不直接执行远程文本。`,
    `## 风险与运行约束\n\n${c.risks}`,
    `## 项目基线\n\n${input.baselines.map((item) => `${name(item.participantId)}：${item.baseline ? `HEAD=${item.baseline.head ?? "无 Git 提交"}；工作区指纹=${item.baseline.treeHash}` : "未提供本地工作区指纹"}`).join("\n\n")}`,
    "## 执行与验收边界\n\n双方须审阅并确认同一份文档。管理员批准本版内容后方可实施；实施、本地测试、真实联合验证与管理员最终验收分别记录。新增要求不继承旧版批准。",
  ].join("\n\n");
}
