import { canonicalJson, type AgentTurnResult, type CollaborationContext } from "@seam/protocol";
import { collectTestFiles } from "./integrity.js";
import { workspaceBaseline } from "./workspace.js";

/** No model or new implementation: prove the approved reuse, then join fresh bilateral checks. */
export async function verifyExecutionReuse(context: CollaborationContext, projectRoot: string): Promise<AgentTurnResult | null> {
  const lifecycle = context.lifecycle;
  if (!lifecycle || lifecycle.paused || context.informationTask || lifecycle.phase !== "executing" || lifecycle.contract?.responsibilities.find(row => row.participantId === context.participant.id)?.mode !== "verify_only") return null;
  const proof = lifecycle.executionReuse?.find(row => row.participantId === context.participant.id);
  const current = await workspaceBaseline(projectRoot), files = await collectTestFiles(projectRoot);
  const sorted = (rows: typeof files) => [...rows].sort((a,b)=>a.path.localeCompare(b.path));
  const valid = proof && lifecycle.approvedHash && lifecycle.approvedHash === lifecycle.documentHash && proof.sourceDocumentHash === lifecycle.baseline?.documentHash && current && current.head === proof.workspace.head && current.treeHash === proof.workspace.treeHash && canonicalJson(sorted(files)) === canonicalJson(sorted(proof.testFiles));
  if (!valid) return { message: "仅验证复用条件已变化，保留现状并等待重新起草及批准。", kind: "status", actions: [{ type: "workflow.blocked", revision: lifecycle.revision, kind: "needs_admin", requiresReview: true, dependencyParticipantIds: [], retryAfterSeconds: 5, category: "code", reason: "仅验证方代码或测试指纹与批准的继承证据不同，未执行修改或发布通过结论。" }], notifyParticipantIds: [], needsHumanInput: false };
  return { message: "Connector已只读核对批准的代码和测试指纹，复用上一版实施证据；本轮无需修改，接下来分别执行新的联合验收。", kind: "status", actions: [{ type: "execution.report", revision: lifecycle.revision, status: "passed", runs: [], category: "code", summary: `仅验证：已核对第${proof.sourceRevision}版实施证据及当前代码/测试指纹。没有修改文件，没有新跑本地单测；本轮联合测试另行实际执行。`, evidence: { reusedImplementation: proof, verification: { currentWorkspace: current, currentTestFiles: files, modelInvoked: false, implementationPerformed: false, localTestsExecuted: false } }, testFiles: files }], notifyParticipantIds: [], needsHumanInput: false };
}
