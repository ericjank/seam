import { canonicalJson, expandSharedContract, workspaceBaselineSchema, type LifecycleContext, type SharedContract } from "@seam/protocol";
import { createHash } from "node:crypto";
import { HttpError } from "./http";

type Row = { participantId: string; workspaceBaseline?: unknown; reportStatus?: string | null; reportEvidence?: Record<string, unknown> | null };
export function executionReuse(contract: SharedContract | null, previous: { revision: number; documentHash: string | null; report: string | null; sharedContract: SharedContract | null } | undefined, before: Row[], current: Row[], strict = false): NonNullable<LifecycleContext["executionReuse"]> {
  const result: NonNullable<LifecycleContext["executionReuse"]> = [];
  for (const responsibility of contract?.responsibilities ?? []) {
    if (responsibility.mode !== "verify_only") continue;
    const prior = before.find(row => row.participantId === responsibility.participantId);
    const workspace = workspaceBaselineSchema.safeParse((prior?.reportEvidence?.workspace as {after?:unknown} | undefined)?.after);
    const planned = workspaceBaselineSchema.safeParse(current.find(row => row.participantId === responsibility.participantId)?.workspaceBaseline);
    const testFiles = prior?.reportEvidence?.testFiles as LifecycleContext["reports"][number]["testFiles"];
    const files = (rows: NonNullable<typeof testFiles>) => [...rows].sort((a,b)=>a.path.localeCompare(b.path));
    const failedPublisher = previous?.sharedContract && before.some(row => ((row.reportEvidence?.independentResults ?? []) as Array<{status:string;caseId:string;id:string}>).some(check => check.status === "failed" && expandSharedContract(previous.sharedContract!).acceptanceCases.some(item => item.id === check.caseId && item.httpChecks?.some(spec => spec.id === check.id && spec.publisherParticipantId === responsibility.participantId))));
    const valid = previous?.documentHash && previous.report && prior?.reportStatus === "passed" && workspace.success && planned.success && testFiles && planned.data.testFiles && workspace.data.head === planned.data.head && workspace.data.treeHash === planned.data.treeHash && canonicalJson(files(testFiles)) === canonicalJson(files(planned.data.testFiles)) && !failedPublisher && !contract?.testChanges?.some(change => change.participantId === responsibility.participantId);
    if (!valid) { if (strict) throw new HttpError(422, "仅验证方必须复用上一版已完成实施的同一代码及测试指纹；失败服务发布方或测试有变化时必须实施"); continue; }
    result.push({ participantId: responsibility.participantId, sourceRevision: previous!.revision, sourceDocumentHash: previous!.documentHash!, sourceReportHash: createHash("sha256").update(previous!.report!).digest("hex"), workspace: workspace.data!, testFiles: testFiles! });
  }
  return result;
}
