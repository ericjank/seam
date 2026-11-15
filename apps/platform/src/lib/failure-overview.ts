import { expandSharedContract, type SharedContract, type LifecycleContext } from "@seam/protocol";
export function failureOverview(contract: SharedContract | null | undefined, reports: Array<{participantId:string; independentResults?: NonNullable<NonNullable<LifecycleContext['baseline']>['failureDigest']>[number]['independentResults']}>) {
  if (!contract) return [];
  const cases = expandSharedContract(contract).acceptanceCases;
  return reports.flatMap(report => (report.independentResults ?? []).filter(result => result.status !== 'passed').flatMap(result => {
    const spec = cases.find(item => item.id === result.caseId)?.httpChecks?.find(check => check.id === result.id);
    const differences = result.mismatches?.length ? result.mismatches : [{path:result.failureStage ?? '未执行',expected:'按批准规范执行',actual:result.summary,actualPresent:true}];
    return differences.map(diff => ({ observerParticipantId:report.participantId, publisherParticipantId:spec?.publisherParticipantId ?? null, requirementIds:spec?.requirementIds ?? [], checkId:result.id, caseId:result.caseId, service:spec?.serviceName ?? '', request:spec ? `${spec.method} ${spec.path}` : '', path:diff.path, expected:JSON.stringify(diff.expected), actual:diff.actualPresent===false?'缺失':JSON.stringify(diff.actual) }));
  }));
}
