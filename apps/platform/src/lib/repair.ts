import { canonicalJson, type LifecycleContext, type SharedContract } from "@seam/protocol";
import { HttpError } from "./http";

/** A repair must not pass by discarding the agreed business coverage. */
export function validateRepairContract(previous: SharedContract, current: SharedContract) {
  const priorIds = previous.effectiveRequirements?.map(row => row.id) ?? [];
  const ids = current.effectiveRequirements?.map(row => row.id) ?? [];
  if (priorIds.length && (ids.length !== priorIds.length || priorIds.some(id => !ids.includes(id)) || current.retiredRequirements?.length)) throw new HttpError(422, "修复方案须沿用原有效要求ID，不得借修复撤销或增加业务目标；目标变更请由管理员追加");
  for (const prior of previous.acceptanceCases) {
    const now = current.acceptanceCases.find(row => row.id === prior.id && row.runnerParticipantId === prior.runnerParticipantId);
    if (!now || prior.requiredAssertions?.some(name => !now.requiredAssertions?.includes(name))) throw new HttpError(422, "修复方案不得删除原验收用例、变更执行方或删减必需断言");
    for (const check of prior.httpChecks ?? []) if (!now.httpChecks?.some(row => row.id === check.id && canonicalJson(row) === canonicalJson(check))) throw new HttpError(422, "修复方案不得删除或改弱已批准的独立HTTP检查；可补充新检查");
  }
  for (const prior of previous.serviceExpectations ?? []) {
    const now = current.serviceExpectations?.find(row => row.name === prior.name && row.publisherParticipantId === prior.publisherParticipantId);
    if (!now || now.healthPath !== prior.healthPath || now.status !== prior.status || prior.bodyChecks.some(check => !now.bodyChecks.some(row => row.path === check.path && (check.path === "revision" || row.equals === check.equals)))) throw new HttpError(422, "修复方案不得移除或削弱原服务就绪检查，revision按当前修订更新");
  }
}

export function repairFailures(contributions: Array<{ participantId: string; reportStatus: string | null; reportSummary: string | null; reportEvidence?: Record<string, unknown> | null; integrationChecks: LifecycleContext["integrationReports"][number]["checks"] | null }>): NonNullable<LifecycleContext["repair"]>["failures"] {
  return contributions.flatMap(row => [
    ...(row.reportStatus === "failed" && (row.reportEvidence?.category ?? "code") === "code" ? [{ participantId: row.participantId, stage: "executing" as const, caseId: null, status: "failed" as const, summary: row.reportSummary ?? "实施失败，读取原始证据定位原因。" }] : []),
    ...(row.integrationChecks ?? []).filter(check => check.status === "failed" && (check.category ?? "code") === "code").map(check => ({ participantId: row.participantId, stage: "joint_verifying" as const, caseId: check.caseId, status: "failed" as const, summary: check.summary })),
  ]);
}

export function validatePinnedTests(before: Array<{ path: string; sha256: string }> | undefined, after: Array<{ path: string; sha256: string }> | undefined, changes: SharedContract["testChanges"], participantId: string, frozen = false) {
  if (!before) return; // Explicitly identifiable legacy/mock plans do not invent file proof.
  if (!after) throw new HttpError(422, "缺少Connector采集的测试文件指纹，不能发布本轮报告");
  if (frozen && after.some(file => !before.some(old => old.path === file.path))) throw new HttpError(422, "联合验收测试文件集合已新增，不能替代冻结的实施测试资料");
  for (const old of before) if (after.find(row => row.path === old.path)?.sha256 !== old.sha256 && !changes?.some(row => row.participantId === participantId && row.path === old.path)) throw new HttpError(422, `测试文件${old.path}已修改或删除，但批准方案未声明该测试变更；请重新起草并批准。`);
}
