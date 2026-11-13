import type { LifecycleContext, SharedContract } from "@seam/protocol";
import { HttpError } from "./http";

/** A repair must not pass by discarding the agreed business coverage. */
export function validateRepairContract(previous: SharedContract, current: SharedContract) {
  const priorIds = previous.effectiveRequirements?.map(row => row.id) ?? [];
  const ids = current.effectiveRequirements?.map(row => row.id) ?? [];
  if (priorIds.length && (ids.length !== priorIds.length || priorIds.some(id => !ids.includes(id)) || current.retiredRequirements?.length)) throw new HttpError(422, "修复方案须沿用原有效要求ID，不得借修复撤销或增加业务目标；目标变更请由管理员追加");
  for (const prior of previous.acceptanceCases) {
    const now = current.acceptanceCases.find(row => row.id === prior.id && row.runnerParticipantId === prior.runnerParticipantId);
    if (!now || prior.requiredAssertions?.some(name => !now.requiredAssertions?.includes(name))) throw new HttpError(422, "修复方案不得删除原验收用例、变更执行方或删减必需断言");
  }
  for (const prior of previous.serviceExpectations ?? []) {
    const now = current.serviceExpectations?.find(row => row.name === prior.name && row.publisherParticipantId === prior.publisherParticipantId);
    if (!now || now.healthPath !== prior.healthPath || now.status !== prior.status || prior.bodyChecks.some(check => !now.bodyChecks.some(row => row.path === check.path && (check.path === "revision" || row.equals === check.equals)))) throw new HttpError(422, "修复方案不得移除或削弱原服务就绪检查，revision按当前修订更新");
  }
}

export function repairFailures(contributions: Array<{ participantId: string; reportStatus: string | null; reportSummary: string | null; integrationChecks: LifecycleContext["integrationReports"][number]["checks"] | null }>): NonNullable<LifecycleContext["repair"]>["failures"] {
  return contributions.flatMap(row => [
    ...(row.reportStatus === "failed" ? [{ participantId: row.participantId, stage: "executing" as const, caseId: null, status: "failed" as const, summary: row.reportSummary ?? "实施失败，读取原始证据定位原因。" }] : []),
    ...(row.integrationChecks ?? []).filter(check => check.status !== "passed").map(check => ({ participantId: row.participantId, stage: "joint_verifying" as const, caseId: check.caseId, status: check.status as "failed" | "not_run", summary: check.summary })),
  ]);
}
