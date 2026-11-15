import { failureOverview } from "@/lib/failure-overview";
import { executionReuse } from "@/lib/execution-reuse";
import { sealFinalDecision } from "@/lib/final-decision";
import { expandSharedContract, normalizeSharedContract } from "@seam/protocol";
import { createHash } from "node:crypto";
import { and, asc, desc, eq, inArray } from "drizzle-orm";
import { CONNECTOR_PROTOCOL_VERSION, canonicalJson, integrationCheckSchema, lifecycleAgentActionSchema, type LifecycleContext, type InformationRequest } from "@seam/protocol";
import { db, withTransaction } from "@/db";
import {
  agents, collaborations, collaborationLifecycles, connectorJobs, lifecycleContributions,
  lifecycleRevisions, messages, participants, projects, auditEvents,
} from "@/db/schema";
import { requireCollaborationAccess } from "@/lib/access";
import { audit } from "@/lib/audit";
import { HttpError } from "@/lib/http";
import { newId } from "@/lib/ids";
import { renderSharedContract, validateSharedContract } from "@/lib/lifecycle-contract";
import { queueWorkflowWakeup } from "./workflow-outbox";
import { authorizeActor, type Actor } from "./actor";
import { answerInformationRequest, openInformationRequest, expireInformationRequest, factFromRequest, administratorFact, informationKey, INFORMATION_TIMEOUT_MS } from "@/lib/information";
import { bindFacts, factsReady, sameBindings } from "@/lib/fact-bindings";
import { repairFailures, validateRepairContract, validatePinnedTests } from "@/lib/repair";

export type LifecyclePhase = LifecycleContext["phase"];
export type LifecycleSnapshot = Pick<LifecycleContext, "revision" | "phase" | "documentHash" | "approvedHash">;
type Lifecycle = typeof collaborationLifecycles.$inferSelect;
type Revision = typeof lifecycleRevisions.$inferSelect;
type Contribution = typeof lifecycleContributions.$inferSelect;

const hash = (content: string) => createHash("sha256").update(content).digest("hex");
const currentContribution = (collaborationId: string, revision: number) => and(
  eq(lifecycleContributions.collaborationId, collaborationId), eq(lifecycleContributions.revision, revision),
);

async function requireAdministrator(userId: string, collaborationId: string) {
  const access = await requireCollaborationAccess(userId, collaborationId, true);
  if (access.role !== "owner") throw new HttpError(403, "只有组织管理员可确认开发文档、追加要求或终止协作");
}

async function getControl(collaborationId: string) {
  const [control] = await db.select().from(collaborationLifecycles)
    .where(eq(collaborationLifecycles.collaborationId, collaborationId)).limit(1);
  return control ?? null;
}

async function getRevision(control: Lifecycle) {
  const [revision] = await db.select().from(lifecycleRevisions).where(and(
    eq(lifecycleRevisions.collaborationId, control.collaborationId), eq(lifecycleRevisions.revision, control.revision),
  )).limit(1);
  if (!revision) throw new HttpError(409, "协作修订记录不存在，不能继续执行");
  return revision;
}

async function getContributions(control: Lifecycle) {
  return db.select().from(lifecycleContributions).where(currentContribution(control.collaborationId, control.revision));
}

async function cancelSupersededReviews(control: Lifecycle, currentAgentId: string | null) {
  const jobs = await db.select().from(connectorJobs).where(and(eq(connectorJobs.collaborationId, control.collaborationId), eq(connectorJobs.kind, "collaboration.turn"), inArray(connectorJobs.status, ["pending", "running"])));
  for (const job of jobs) {
    const snapshot = (job.payload as { lifecycleSnapshot?: LifecycleSnapshot }).lifecycleSnapshot;
    if (job.agentId === currentAgentId || snapshot?.revision !== control.revision || !["plan_synthesis", "plan_confirmation"].includes(snapshot.phase)) continue;
    await db.update(connectorJobs).set({ status: "cancelled", error: "共同文档已更新，旧只读任务已被替代", leaseUntil: null, updatedAt: new Date() }).where(eq(connectorJobs.id, job.id));
  }
}

function contextFrom(control: Lifecycle, revision: Revision, contributions: Contribution[], previous?: Revision, previousContributions:Contribution[]=[]): LifecycleContext {
  const relevant = contributions.filter((row) => control.requiredParticipantIds.includes(row.participantId));
  return {
    revision: control.revision, phase: control.phase, requirements: revision.requirements,
    document: revision.document, documentHash: control.documentHash, approvedHash: control.approvedHash,
    requiredParticipantIds: control.requiredParticipantIds, coordinatorParticipantId: control.requiredParticipantIds[0], paused: Boolean(control.pausedAt),
    changeRequest: revision.changeRequest, contract: revision.sharedContract, objections: revision.objections ?? [],
    executionReuse: executionReuse(revision.sharedContract, previous, previousContributions, relevant),
    retryBudget: revision.retryBudget ?? { grants: [], stops: [] },
    repair: revision.repair ?? null, informationRequests: revision.informationRequests ?? [],
    protocolVersion: control.protocolVersion ?? 1, facts: (control.facts ?? []).map(fact => fact.status === "active" && Date.parse(fact.validUntil) <= Date.now() ? { ...fact, status: "stale" as const } : (control.protocolVersion??1)>=7 && fact.status==="active" && fact.verifiedRevision!==control.revision ? {...fact,status:"unverified" as const}:fact),
    attemptHistory: revision.attemptHistory ?? [], factBindings:revision.factBindings??[], approvalPending:revision.approvalIntent?{documentHash:revision.approvalIntent.documentHash,requestedAt:revision.approvalIntent.requestedAt}:null,
    baseline: previous ? { revision: previous.revision, documentHash: previous.documentHash, document: previous.sharedContract?.effectiveRequirements ? null : previous.document, contract: previous.sharedContract, report: previous.report, failureDigest:previousContributions.map(row=>({participantId:row.participantId,summary:row.reportSummary??"",checks:(row.integrationChecks??[]).filter(check=>check.status!=="passed").map(check=>({caseId:check.caseId,status:check.status,summary:check.summary})),independentResults:((row.reportEvidence?.independentResults??[]) as NonNullable<Extract<import("@seam/protocol").LifecycleAgentAction,{type:"integration.report"}>["independentResults"]>).filter(result=>result.status!=="passed"),runs:(row.evidenceRuns??[]).map(run=>({id:run.id,command:run.command,exitCode:run.exitCode}))})), informationRequests: previous.informationRequests?.filter(row => row.status === "answered") } : null,
    contributions: relevant.flatMap((row) => row.content ? [{ participantId: row.participantId, content: row.content, baseline: row.workspaceBaseline ?? null, factRefs:row.factRefs??[] }] : []),
    confirmations: relevant.filter((row) => control.documentHash && row.confirmedHash === control.documentHash).map((row) => row.participantId),
    reports: relevant.flatMap((row) => row.reportStatus && row.reportSummary ? [{
      participantId: row.participantId, status: row.reportStatus, summary: row.reportSummary, evidence: row.reportEvidence ?? {}, testFiles: (row.reportEvidence?.testFiles as import("@seam/protocol").CommandEvidence["testFiles"] | undefined),
    }] : []),
    integrationReports: relevant.flatMap((row) => row.integrationChecks ? [{ participantId: row.participantId, checks: row.integrationChecks.map((check) => integrationCheckSchema.parse(check)) }] : []),
    report: revision.report, reportHash: revision.report ? hash(revision.report) : null, finalDecision: control.finalDecision ?? null,
    blocks: relevant.flatMap((row) => row.block?.phase === control.phase ? [{ ...row.block, participantId: row.participantId }] : []),
    services: relevant.flatMap((row) => (row.services ?? []).filter((service) => Date.parse(service.expiresAt) > Date.now()).map((service) => ({ ...service, participantId: row.participantId }))),
    evidenceRuns: relevant.flatMap((row) => (row.evidenceRuns ?? []).map((run) => ({ ...run, participantId: row.participantId }))),
  };
}

export async function getLifecycleContext(collaborationId: string): Promise<LifecycleContext | null> {
  const control = await getControl(collaborationId);
  if (!control) return null;
  const [previous] = control.revision > 1 ? await db.select().from(lifecycleRevisions).where(and(eq(lifecycleRevisions.collaborationId, collaborationId), eq(lifecycleRevisions.revision, control.revision - 1))).limit(1) : [];
  return contextFrom(control, await getRevision(control), await getContributions(control), previous, previous?await db.select().from(lifecycleContributions).where(currentContribution(collaborationId,previous.revision)):[]);
}

export async function getLifecycleSnapshot(collaborationId: string): Promise<LifecycleSnapshot | null> {
  const control = await getControl(collaborationId);
  if (!control) return null;
  return { revision: control.revision, phase: control.phase, documentHash: control.documentHash, approvedHash: control.approvedHash };
}

export async function assertLifecycleJobCurrent(
  collaborationId: string, snapshot: LifecycleSnapshot | null | undefined,
): Promise<LifecycleContext | null> {
  const current = await getLifecycleContext(collaborationId);
  if (!current) return null;
  if (current.paused) throw new HttpError(409, "管理员已暂停协作，旧任务不能继续执行或回传");
  if (current.phase === "terminated") throw new HttpError(409, "管理员已终止协作，旧任务不能继续执行或回传");
  if (!snapshot || snapshot.revision !== current.revision) throw new HttpError(409, "协作要求已更新，旧修订任务已失效");
  const confirmationCompleted = snapshot.phase === "plan_confirmation" && current.phase === "awaiting_approval";
  if ((!confirmationCompleted && snapshot.phase !== current.phase) || snapshot.documentHash !== current.documentHash || snapshot.approvedHash !== current.approvedHash) {
    throw new HttpError(409, "协作阶段或文档已改变，请使用当前版本重新领取任务");
  }
  return current;
}

async function notify(collaborationId: string, body: string, metadata:Record<string,unknown> = {}) {
  await db.insert(messages).values({ id: newId(), collaborationId, authorType: "system", authorName: "Seam", kind: "system", body, metadata });
  await db.update(collaborations).set({ updatedAt: new Date() }).where(eq(collaborations.id, collaborationId));
}

async function locked<T>(collaborationId: string, run: (control: Lifecycle | null, collaboration: typeof collaborations.$inferSelect) => Promise<T>) {
  return withTransaction(async () => {
    const [collaboration] = await db.select().from(collaborations).where(eq(collaborations.id, collaborationId)).limit(1).for("update");
    if (!collaboration) throw new HttpError(404, "协作不存在");
    const before=await getControl(collaborationId);
    const state=(value:Lifecycle|null)=>value?{revision:value.revision,phase:value.phase,documentHash:value.documentHash,approvedHash:value.approvedHash,paused:Boolean(value.pausedAt)}:null;
    const previous=state(before),result=await run(before,collaboration),current=state(await getControl(collaborationId));
    if(current&&canonicalJson(previous)!==canonicalJson(current))await audit({collaborationId,actorType:"system",actorId:"seam",action:"lifecycle.transition",metadata:{previous,current}});
    return result;
  });
}

async function requiredProjects(control: Pick<Lifecycle, "collaborationId" | "requiredParticipantIds">, connected = false) {
  const rows = await db.select({ participant: participants, project: projects, agent: agents }).from(participants)
    .innerJoin(projects, eq(projects.id, participants.projectId)).leftJoin(agents, eq(agents.id, participants.agentId))
    .where(eq(participants.collaborationId, control.collaborationId)).orderBy(asc(participants.createdAt), asc(participants.id));
  const required = rows.filter((row) => control.requiredParticipantIds.includes(row.participant.id));
  if (required.length < 2 || required.length !== control.requiredParticipantIds.length || required.some((row) => row.participant.status !== "active" || !row.agent)) {
    throw new HttpError(409, "共同开发需要至少两个已接受协作并绑定 Agent 的项目");
  }
  if (connected && required.some((row) => !row.agent?.lastSeenAt || row.agent.lastSeenAt.getTime() < Date.now() - 90_000 || !["online", "busy"].includes(row.agent.status))) {
    throw new HttpError(409, "请先启动双方本地 Connector 并确认在线，再提交共同开发目标");
  }
  if (connected) {
    const reports = await db.select().from(auditEvents).where(and(eq(auditEvents.action, "connector.capabilities"), inArray(auditEvents.actorId, required.map(row => row.agent!.id)))).orderBy(desc(auditEvents.sequence));
    const incompatible = required.filter(row => {
      const capability = reports.find(report => report.actorId === row.agent!.id)?.metadata as { protocolVersion?: number; supportsInformationLookup?: boolean } | undefined;
      return !capability?.supportsInformationLookup || (capability.protocolVersion ?? 1) < CONNECTOR_PROTOCOL_VERSION;
    });
    if (incompatible.length) throw new HttpError(409, `请先升级并重启Connector（协议${CONNECTOR_PROTOCOL_VERSION}）：${incompatible.map(row => `${row.project.name} / ${row.agent!.name}`).join("、")}；在线状态不能代替协议能力。`);
  }
  return required;
}

export async function startLifecycle(userId: string, collaborationId: string): Promise<LifecycleContext> {
  return locked(collaborationId, async (control, collaboration) => {
    await requireAdministrator(userId, collaborationId);
    if (control) return (await getLifecycleContext(collaborationId))!;
    const active = await db.select().from(participants).where(and(eq(participants.collaborationId, collaborationId), eq(participants.status, "active"))).orderBy(asc(participants.createdAt), asc(participants.id));
    const requiredParticipantIds = active.map((participant) => participant.id);
    await requiredProjects({ collaborationId, requiredParticipantIds }, true);
    await db.insert(collaborationLifecycles).values({ collaborationId, requiredParticipantIds, revision: 1, phase: "planning", protocolVersion: CONNECTOR_PROTOCOL_VERSION });
    await db.insert(lifecycleRevisions).values({ id: newId(), collaborationId, revision: 1, requirements: collaboration.objective, createdById: userId });
    await db.update(collaborations).set({ status: "negotiating", updatedAt: new Date() }).where(eq(collaborations.id, collaborationId));
    await notify(collaborationId, "目标已提交。双方 AI 将先协商共同开发文档；管理员确认指定版本和内容后才会执行开发。");
    await audit({ collaborationId, actorType: "user", actorId: userId, action: "lifecycle.started", metadata: { revision: 1, requiredParticipantIds } });
    await queueWorkflowWakeup(collaborationId);
    return (await getLifecycleContext(collaborationId))!;
  });
}

async function beginInformationLookup(control: Lifecycle, participantId: string, question: string, searched?: InformationRequest["responses"][number]["sources"], options: { key?: string; fresh?: boolean; resumeRequiresReview?: boolean; forceVerifyKey?:string; purpose?:InformationRequest["purpose"] } = {}) {
  if ((control.protocolVersion ?? 1) < CONNECTOR_PROTOCOL_VERSION) {
    await db.update(collaborationLifecycles).set({ protocolVersion: CONNECTOR_PROTOCOL_VERSION, updatedAt: new Date() }).where(eq(collaborationLifecycles.collaborationId, control.collaborationId));
    control.protocolVersion = CONNECTOR_PROTOCOL_VERSION;
  }
  const revision = await getRevision(control);
  const outcome = openInformationRequest({ requests: revision.informationRequests ?? [], id: newId(), revision: control.revision,
    phase: control.phase, participantId, requiredParticipantIds: control.requiredParticipantIds, question, searched, now: new Date().toISOString(), facts: control.facts ?? [], ...options });
  await db.update(lifecycleRevisions).set({ informationRequests: outcome.requests, updatedAt: new Date() }).where(eq(lifecycleRevisions.id, revision.id));
  const resolved = outcome.request?.status === "answered";
  const block: Omit<LifecycleContext["blocks"][number], "participantId"> | null = resolved && !options.resumeRequiresReview ? null : {
    kind: resolved ? "needs_admin" : outcome.request ? "gathering_info" : "needs_admin", requiresReview: resolved && options.resumeRequiresReview,
    reason: resolved ? "失败后的事实已复用，仍待管理员确认重试。" : outcome.request ? question : `该问题的自动查找失败预算已用尽，请结合原始来源补充或重新查找：${question}`.slice(0, 5000),
    phase: control.phase, attempts: 1, retryAfterSeconds: 5, retryAt: null, dependencyParticipantIds: [],
    ...(outcome.request ? { informationRequestId: outcome.request.id } : {}),
  };
  await db.insert(lifecycleContributions).values({ id: newId(), collaborationId: control.collaborationId, revision: control.revision, participantId, block }).onDuplicateKeyUpdate({ set: { block, updatedAt: new Date() } });
  if (outcome.request) { await queueWorkflowWakeup(control.collaborationId); if (outcome.request.status !== "answered") await queueWorkflowWakeup(control.collaborationId, undefined, INFORMATION_TIMEOUT_MS); }
  await notify(control.collaborationId, outcome.request?.status === "answered" ? `已复用管理员提供且仍有效的共享事实：${question}` : outcome.request ? `正在自动获取缺失信息：${question}；先查本地与共享资料，再向对端询证。` : block!.reason, outcome.request?{informationRequestIds:[outcome.request.id]}:{});
}

async function scheduleFactGates(control:Lifecycle, participantId:string, refs:string[]) {
  bindFacts(refs,control.facts??[]);
  for(const key of refs) if(!factsReady([key],control.facts??[],control.revision)) {
    const fact=control.facts!.find(row=>row.key===key)!;
    if(fact.authority==="administrator"&&Date.parse(fact.validUntil)>Date.now()) {
      control.facts=control.facts!.map(row=>row.key===key?{...row,verifiedRevision:control.revision}:row);
      await db.update(collaborationLifecycles).set({facts:control.facts}).where(eq(collaborationLifecycles.collaborationId,control.collaborationId));continue;
    }
    await beginInformationLookup(control,participantId,`核验本修订引用的共享事实：${fact.question}`,undefined,{key,forceVerifyKey:key,purpose:"fact_gate"});
  }
  if(factsReady(refs,control.facts??[],control.revision))await settleFactGates(control);
}

async function finishPlanning(control:Lifecycle, currentAgentId:string|null) {
  const contributions=await getContributions(control), allSubmitted=control.requiredParticipantIds.every(id=>contributions.some(row=>row.participantId===id&&row.content&&!row.pendingPlan));
  await db.update(lifecycleContributions).set({confirmedHash:null,updatedAt:new Date()}).where(currentContribution(control.collaborationId,control.revision));
  const revision=await getRevision(control);
  await db.update(lifecycleRevisions).set({document:null,documentHash:null,sharedContract:null,factBindings:null,approvalIntent:null,updatedAt:new Date()}).where(eq(lifecycleRevisions.id,revision.id));
  await db.update(collaborationLifecycles).set({phase:allSubmitted?"plan_synthesis":"planning",documentHash:null,approvedHash:null,approvedById:null,approvedAt:null,updatedAt:new Date()}).where(eq(collaborationLifecycles.collaborationId,control.collaborationId));
  if(control.phase!=="planning")await cancelSupersededReviews(control,currentAgentId);
  await notify(control.collaborationId,allSubmitted?"各方分析及本轮事实核验已收齐，协调方汇总完整共同文档。":"已收到本方分析，等待其他项目或本轮事实核验。");
}

async function commitLifecycleApproval(userId:string, control:Lifecycle, documentHash:string) {
  await db.update(collaborationLifecycles).set({phase:"executing",approvedHash:documentHash,approvedById:userId,approvedAt:new Date(),updatedAt:new Date()}).where(eq(collaborationLifecycles.collaborationId,control.collaborationId));
  const revision=await getRevision(control);
  await db.update(lifecycleRevisions).set({approvalIntent:null,updatedAt:new Date()}).where(eq(lifecycleRevisions.id,revision.id));
  await db.update(collaborations).set({status:"in_progress",updatedAt:new Date()}).where(eq(collaborations.id,control.collaborationId));
  await notify(control.collaborationId,`管理员已确认第 ${control.revision} 版完整开发文档（${documentHash}），本轮引用事实已核验。双方可按此版实施。`);
  await audit({collaborationId:control.collaborationId,actorType:"user",actorId:userId,action:"lifecycle.approved",metadata:{revision:control.revision,documentHash}});
  await queueWorkflowWakeup(control.collaborationId);
}

async function settleFactGates(control:Lifecycle,currentAgentId:string|null=null) {
  const current=(await getControl(control.collaborationId))!,facts=current.facts??[],revision=await getRevision(current),rows=await getContributions(current);
  let plansChanged=false;
  for(const row of rows) if(row.pendingPlan&&factsReady(row.pendingPlan.factRefs,facts,current.revision)) {
    const pending=row.pendingPlan,unchanged=sameBindings(pending.bindings,bindFacts(pending.factRefs,facts));
    await db.update(lifecycleContributions).set({pendingPlan:null,content:unchanged?pending.content:null,workspaceBaseline:pending.baseline??null,factRefs:pending.factRefs,block:null,updatedAt:new Date()}).where(eq(lifecycleContributions.id,row.id));
    plansChanged=true;
    await notify(current.collaborationId,unchanged?"引用事实来源已核对且未变化，自动接续已保存的本方分析，无需模型重复提交。":"引用事实已变化，旧分析不再采用；本方Agent将按当前资料只读重新规划。");
  }
  if(plansChanged&&["planning","plan_synthesis","plan_confirmation"].includes(current.phase)) {await finishPlanning(current,currentAgentId);await queueWorkflowWakeup(current.collaborationId);return;}
  const refs=revision.sharedContract?.factRefs??[];
  if(!refs.length||!current.documentHash||!["plan_confirmation","awaiting_approval"].includes(current.phase))return;
  if(!factsReady(refs,facts,current.revision))return;
  if(!sameBindings(revision.factBindings??[],bindFacts(refs,facts))) {
    for(const row of rows) if(row.factRefs?.some(key=>refs.includes(key))) await db.update(lifecycleContributions).set({content:null,pendingPlan:null,confirmedHash:null,block:null,updatedAt:new Date()}).where(eq(lifecycleContributions.id,row.id));
    await finishPlanning(current,currentAgentId);
    await notify(current.collaborationId,"完整文档引用的事实来源或值已变化，旧批准意图已作废；自动重新规划并等待管理员批准新文档。");await queueWorkflowWakeup(current.collaborationId);return;
  }
  const intent=revision.approvalIntent;
  if(intent&&current.phase==="awaiting_approval"&&intent.documentHash===current.documentHash&&!current.pausedAt&&current.requiredParticipantIds.every(id=>rows.some(row=>row.participantId===id&&row.confirmedHash===current.documentHash))) {
    try {await requireAdministrator(intent.userId,current.collaborationId);}
    catch {await db.update(lifecycleRevisions).set({approvalIntent:null}).where(eq(lifecycleRevisions.id,revision.id));await notify(current.collaborationId,"原确认人的权限已变化，事实核验已保留，需当前管理员审阅。");return;}
    await commitLifecycleApproval(intent.userId,current,current.documentHash);
  }
}

async function cancelInformationJobs(control: Lifecycle, requestId: string, keepAgentId: string | null = null) {
  const jobs = await db.select().from(connectorJobs).where(and(eq(connectorJobs.collaborationId, control.collaborationId), inArray(connectorJobs.status, ["pending", "running"])));
  for (const job of jobs) if (job.agentId !== keepAgentId && (job.payload as { context?: { informationTask?: { requestId?: string } } }).context?.informationTask?.requestId === requestId) {
    await db.update(connectorJobs).set({ status: "cancelled", leaseUntil: null, error: "资料查找轮次已变化，旧答复不能续接或发布", updatedAt: new Date() }).where(eq(connectorJobs.id, job.id));
  }
}

async function syncInformationBlock(control: Lifecycle, owner: Contribution | undefined, requests: InformationRequest[]) {
  if (!owner) return;
  const own = requests.filter(row => row.requestedByParticipantId === owner.participantId && row.phase === control.phase);
  const unresolved = own.find(row => row.status === "needs_admin") ?? own.find(row => ["pending", "conflicted"].includes(row.status));
  const review = own.find(row => row.status === "answered" && row.resumeRequiresReview && !row.reviewApprovedAt);
  const active = unresolved ?? review;
  if (!active && !owner.block?.informationRequestId) return;
  await db.update(lifecycleContributions).set({ block: active ? {
    kind: active.status === "needs_admin" || !unresolved && review ? "needs_admin" : "gathering_info",
    requiresReview: !unresolved && !!review, reason: (!unresolved && review ? "失败后的必要事实已补齐，仍待管理员确认重试。" : active.failureReason ?? active.question).slice(0, 5000),
    phase: control.phase, attempts: active.attempt ?? 1, retryAt: null, retryAfterSeconds: 5, dependencyParticipantIds: [], informationRequestId: active.id,
  } : null, updatedAt: new Date() }).where(eq(lifecycleContributions.id, owner.id));
}

/** Durable deadlines are recovered by existing poll/heartbeat and page maintenance. */
export async function recoverInformationLookups(collaborationId: string) {
  return locked(collaborationId, async control => {
    if (!control || control.pausedAt || control.phase === "terminated") return;
    const revision = await getRevision(control), requests = revision.informationRequests ?? [];
    const updated = requests.map(request => request.phase === control.phase ? expireInformationRequest(request, Date.now()) : request);
    if (updated.every((request, index) => request === requests[index])) return;
    await db.update(lifecycleRevisions).set({ informationRequests: updated, updatedAt: new Date() }).where(eq(lifecycleRevisions.id, revision.id));
    const contributions = await getContributions(control);
    for (const [index, request] of updated.entries()) {
      if (request === requests[index]) continue;
      await cancelInformationJobs(control, request.id);
      const owner = contributions.find(row => row.participantId === request.requestedByParticipantId);
      if (owner?.block?.informationRequestId === request.id) await db.update(lifecycleContributions).set({ block: { ...owner.block, kind: request.status === "needs_admin" ? "needs_admin" : "gathering_info", reason: request.failureReason!, retryAt: null }, updatedAt: new Date() }).where(eq(lifecycleContributions.id, owner.id));
      await notify(collaborationId, `${request.failureReason} ${request.status === "needs_admin" ? "自动重试已穷尽，恢复后可由管理员点击重新查找。" : "已安排有界退避，旧轮次执行已取消。"}`);
      if (request.status !== "needs_admin") {
        await queueWorkflowWakeup(collaborationId, undefined, Math.max(1, Date.parse(request.retryAt!) - Date.now()));
        await queueWorkflowWakeup(collaborationId, undefined, Math.max(1, Date.parse(request.deadlineAt!) - Date.now()));
      }
    }
  });
}

export async function retryInformationLookup(userId: string, collaborationId: string, requestId: string) {
  return locked(collaborationId, async control => {
    await requireAdministrator(userId, collaborationId);
    if (!control || control.pausedAt || control.phase === "terminated") throw new HttpError(409, "当前任务不能重启资料查找");
    const revision = await getRevision(control), request = revision.informationRequests?.find(row => row.id === requestId);
    if (!request || request.phase !== control.phase || request.status !== "needs_admin") throw new HttpError(409, "只能重启当前阶段已穷尽的资料查找");
    if (request.responses.length + request.targetParticipantIds.length * 3 > 500) throw new HttpError(409, "该问题的查找归档已达上限，请补充确切事实或在新修订中重新核对");
    const next = { ...request, status: request.stage === "reconcile" ? "conflicted" as const : "pending" as const, attempt: (request.attempt ?? 1) + 1, retryCount: 0, retryAt: null, deadlineAt: new Date(Date.now() + INFORMATION_TIMEOUT_MS).toISOString(), failureReason: undefined };
    await cancelInformationJobs(control, request.id);
    await db.update(lifecycleRevisions).set({ informationRequests: revision.informationRequests!.map(row => row.id === request.id ? next : row), updatedAt: new Date() }).where(eq(lifecycleRevisions.id, revision.id));
    const owner = (await getContributions(control)).find(row => row.participantId === request.requestedByParticipantId);
    if (owner?.block) await db.update(lifecycleContributions).set({ block: { ...owner.block, kind: "gathering_info", reason: request.question, retryAt: null }, updatedAt: new Date() }).where(eq(lifecycleContributions.id, owner.id));
    await audit({ collaborationId, actorType: "user", actorId: userId, action: "information.retried", metadata: { requestId, attempt: next.attempt } });
    await queueWorkflowWakeup(collaborationId); await queueWorkflowWakeup(collaborationId, undefined, INFORMATION_TIMEOUT_MS);
    return (await getLifecycleContext(collaborationId))!;
  });
}

export async function resolveInformation(userId: string, collaborationId: string, requestId: string, answer: string) {
  return locked(collaborationId, async control => {
    await requireAdministrator(userId, collaborationId);
    if (!control || control.pausedAt || control.phase === "terminated" || !answer.trim() || answer.length > 5000) throw new HttpError(409, "当前任务或补充事实无效");
    const revision = await getRevision(control), request = revision.informationRequests?.find(row => row.id === requestId);
    if (!request || request.phase !== control.phase || request.status !== "needs_admin") throw new HttpError(409, "只能补充当前已穷尽问题的事实");
    const updated = { ...request, status: "answered" as const, answer: answer.trim(), administratorResolution: { answer: answer.trim(), providedAt: new Date().toISOString() } }, fact = administratorFact(updated, answer.trim());
    await db.update(lifecycleRevisions).set({ informationRequests: revision.informationRequests!.map(row => row.id === request.id ? updated : row), updatedAt: new Date() }).where(eq(lifecycleRevisions.id, revision.id));
    await db.update(collaborationLifecycles).set({ facts: [...(control.facts ?? []).filter(row => row.key !== fact.key), fact].slice(-200), updatedAt: new Date() }).where(eq(collaborationLifecycles.collaborationId, collaborationId));
    const owner = (await getContributions(control)).find(row => row.participantId === request.requestedByParticipantId);
    await syncInformationBlock(control, owner, revision.informationRequests!.map(row => row.id === request.id ? updated : row));
    await settleFactGates(control);
    await db.insert(messages).values({ id: newId(), collaborationId, authorType: "user", authorName: "管理员补充事实", kind: "clarification", body: answer.trim(), metadata: { blockResolution: true, requestId, dispatch: false } });
    await queueWorkflowWakeup(collaborationId);
    return (await getLifecycleContext(collaborationId))!;
  });
}

export async function applyLifecycleAction(actor: Actor, collaborationId: string, rawAction: import("zod").input<typeof lifecycleAgentActionSchema>): Promise<{ changed: boolean }> {
  const inputAction = lifecycleAgentActionSchema.parse(rawAction);
  return locked(collaborationId, async (control, collaboration) => {
    let preparedAction = inputAction;
    if (!control) throw new HttpError(409, "该协作尚未启用管理员确认开发流程");
    const participantId = await authorizeActor(actor, collaborationId);
    if (!participantId || actor.kind !== "participant" || !control.requiredParticipantIds.includes(participantId)) throw new HttpError(403, "仅本轮指定的项目 Agent 可提交计划、确认或实施报告");
    if (control.pausedAt || inputAction.revision !== control.revision || control.phase === "terminated") throw new HttpError(409, "协作修订已失效或已终止");
    const required = await requiredProjects(control);
    const currentAgentId = required.find((row) => row.participant.id === participantId)?.participant.agentId ?? null;
    const revision = await getRevision(control);
    const existing = (await getContributions(control)).find((row) => row.participantId === participantId);
    if (inputAction.type === "plan.amend") {
      if (!revision.repair || control.phase !== "planning") throw new HttpError(409, "仅修复规划阶段可提交基于上版的增量分析");
      preparedAction = { type: "plan.submit", revision: inputAction.revision, baseline: inputAction.baseline, factRefs:inputAction.factRefs,
        content: `本方沿用第${revision.repair.sourceRevision}版完整共同文档和既有业务目标，基线文档${revision.repair.sourceDocumentHash}。\n\n本轮修复变更：\n${inputAction.changes}\n\n双方确认完整新版后仍需管理员批准，批准前不修改代码或运行验证。` };
    }
    if (inputAction.type === "plan.patch") {
      const context = (await getLifecycleContext(collaborationId))!, base = revision.sharedContract ?? context.baseline?.contract;
      if (!revision.repair || control.phase !== "plan_synthesis" || !base || inputAction.baseDocumentHash !== (control.documentHash ?? context.baseline?.documentHash)) throw new HttpError(409, "修复差异必须基于当前已知完整契约指纹");
      preparedAction = { type: "plan.compose", revision: inputAction.revision, baseDocumentHash: control.documentHash,
        contract: { ...base, ...inputAction.delta, effectiveRequirements: base.effectiveRequirements, retiredRequirements: [] } };
    }
    const action = preparedAction;
    if (action.type === "plan.amend" || action.type === "plan.patch") throw new HttpError(422, "增量方案未能归一为完整契约操作");
    if (action.type === "information.request") {
      if (!["planning", "plan_synthesis", "plan_confirmation", "executing", "joint_verifying"].includes(control.phase)) throw new HttpError(409, "当前阶段不能开始自动信息查找");
      await beginInformationLookup(control, participantId, action.question, action.searched, { key: action.key, fresh: action.fresh });
      return { changed: true };
    }
    if (action.type === "information.respond") {
      const requests = revision.informationRequests ?? [];
      const request = requests.find(row => row.id === action.requestId);
      if (!request) throw new HttpError(404, "信息请求不属于当前协作和修订");
      const updated = answerInformationRequest(request, participantId, action, control.phase);
      await db.update(lifecycleRevisions).set({ informationRequests: requests.map(row => row.id === request.id ? updated : row), updatedAt: new Date() }).where(eq(lifecycleRevisions.id, revision.id));
      const owner = (await getContributions(control)).find(row => row.participantId === request.requestedByParticipantId);
      await syncInformationBlock(control, owner, requests.map(row => row.id === request.id ? updated : row));
      const fact = request.purpose==="diagnostic"?null:factFromRequest(updated), key = informationKey(request.question, request.key);
      const facts = (control.facts ?? []).map(row => row.key === key && (updated.status === "conflicted" || request.stage === "verify" && action.status === "unavailable") ? { ...row, status: updated.status === "conflicted" ? "conflicted" as const : "stale" as const } : row);
      await db.update(collaborationLifecycles).set({ facts: fact ? [...facts.filter(row => row.key !== fact.key), fact].slice(-200) : facts, updatedAt: new Date() }).where(eq(collaborationLifecycles.collaborationId, collaborationId));
      if(request.purpose==="diagnostic"&&updated.status==="answered") {
        const category=action.diagnosisCategory??"unknown",currentOwner=(await getContributions(control)).find(row=>row.participantId===request.requestedByParticipantId);
        if(currentOwner?.block)await db.update(lifecycleContributions).set({block:{...currentOwner.block,kind:"needs_admin",category,requiresReview:true,requiresAuthorization:category==="authorization",reason:`本地Agent只读诊断：${updated.answer}；分类=${category}。管理员确认前不重新实施或验证。`.slice(0,5000)},updatedAt:new Date()}).where(eq(lifecycleContributions.id,currentOwner.id));
        await audit({collaborationId,actorType:"agent",actorId:participantId,action:"lifecycle.diagnosed",metadata:{revision:control.revision,requestId:request.id,category}});
      }
      await settleFactGates(control,currentAgentId);
      if ((updated.attempt ?? 1) !== (request.attempt ?? 1)) await cancelInformationJobs(control, request.id, currentAgentId);
      await notify(collaborationId, updated.status === "answered" ? `缺失信息已获取，将自动续接原阶段：${request.question}` : updated.status === "needs_admin" ? `自动查找已穷尽，请管理员仅补充缺失事实：${request.question}` : `本地共享资料不足，正在向对端询证：${request.question}`, {informationRequestIds:[request.id]});
      await queueWorkflowWakeup(collaborationId, undefined, updated.retryAt ? Math.max(0, Date.parse(updated.retryAt) - Date.now()) : 0);
      if (["pending", "conflicted"].includes(updated.status)) await queueWorkflowWakeup(collaborationId, undefined, Math.max(1, Date.parse(updated.deadlineAt!) - Date.now()));
      return { changed: true };
    }
    if (action.type === "workflow.blocked") {
      if (action.kind === "gathering_info") throw new HttpError(422, "信息查找状态由平台调度，请提交information.request或明确缺失事实");
      if (action.dependencyParticipantIds.some((id) => id === participantId || !control.requiredParticipantIds.includes(id))) throw new HttpError(422, "等待对象必须为当前协作的其他参与方");
      const attempts = existing?.block?.phase === control.phase && existing.block.kind === action.kind ? existing.block.attempts + 1 : 1;
      const kind = action.kind === "retryable" && attempts >= 3 ? "needs_admin" : action.kind;
      if (kind === "needs_admin" && !action.requiresAuthorization && !action.requiresReview) {
        await beginInformationLookup(control, participantId, action.reason);
        return { changed: true };
      }
      const block = { kind, reason: action.reason, dependencyParticipantIds: action.dependencyParticipantIds, retryAfterSeconds: action.retryAfterSeconds, phase: control.phase, attempts,
        requiresAuthorization: action.requiresAuthorization, requiresReview: action.requiresReview, category: action.category, retryAt: kind === "needs_admin" ? null : new Date(Date.now() + action.retryAfterSeconds * 1000).toISOString() };
      await db.insert(lifecycleContributions).values({ id: newId(), collaborationId, revision: control.revision, participantId, block }).onDuplicateKeyUpdate({ set: { block, updatedAt: new Date() } });
      const blockedRows = (await getContributions(control)).filter((row) => row.block?.phase === control.phase);
      const waiting = new Set(blockedRows.filter((row) => row.block?.kind === "waiting_peer").map((row) => row.participantId));
      if (control.requiredParticipantIds.every((id) => waiting.has(id)) && blockedRows.every((row) => row.block!.dependencyParticipantIds.length && row.block!.dependencyParticipantIds.every((id) => waiting.has(id)))) {
        for (const row of blockedRows) await beginInformationLookup(control, row.participantId, `检测到循环等待，请先查本地与共享资料，确定可先完成的步骤及实际依赖：${row.block!.reason}`.slice(0, 5000));
        await notify(collaborationId, "检测到双方循环等待，正在通过只读信息查找核对依赖，不立即要求人工填写。");
        return { changed: true };
      }
      if (kind !== "needs_admin") await queueWorkflowWakeup(collaborationId, undefined, action.retryAfterSeconds * 1000);
      await notify(collaborationId, `${kind === "needs_admin" ? "需要管理员补充必要信息" : kind === "waiting_peer" ? "等待对端资料或服务就绪" : "临时故障，等待退避重试"}：${action.reason}`);
      return { changed: true };
    }
    if (action.type === "service.publish") {
      if (!["executing", "joint_verifying"].includes(control.phase) || control.approvedHash !== control.documentHash || !control.approvedHash) throw new HttpError(409, "服务端点只能在本版获批后发布");
      const url = new URL(action.baseUrl);
      if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || !action.probe?.ok) throw new HttpError(422, "服务端点必须经本机实际健康探测，地址不得包含凭据");
      const expectations = revision.sharedContract?.serviceExpectations;
      const expected = expectations?.find((item) => item.name === action.name && item.publisherParticipantId === participantId);
      if (expectations && (!expected || expected.healthPath !== action.healthPath || action.probe.status !== expected.status
        || action.probe.revision !== control.revision || action.probe.documentHash !== control.approvedHash || action.probe.expectationHash !== hash(canonicalJson(expected)))) throw new HttpError(422, "服务缺少与本版批准就绪契约匹配的本机探测证据");
      const service = { name: action.name, baseUrl: action.baseUrl, healthPath: action.healthPath, ttlSeconds: action.ttlSeconds, probe: action.probe, expiresAt: new Date(Date.now() + action.ttlSeconds * 1000).toISOString() };
      const services = [...(existing?.services ?? []).filter((item) => item.name !== action.name), service];
      await db.insert(lifecycleContributions).values({ id: newId(), collaborationId, revision: control.revision, participantId, services }).onDuplicateKeyUpdate({ set: { services, updatedAt: new Date() } });
      return { changed: true };
    }
    if (existing?.block) await db.update(lifecycleContributions).set({ block: null, updatedAt: new Date() }).where(eq(lifecycleContributions.id, existing.id));
    if (action.type === "plan.submit") {
      if (!["planning", "plan_synthesis", "plan_confirmation"].includes(control.phase)) throw new HttpError(409, "当前阶段不能修改开发文档");
      if (existing?.content === action.content && JSON.stringify(existing.workspaceBaseline ?? null) === JSON.stringify(action.baseline ?? null) && canonicalJson(existing.factRefs??[])===canonicalJson(action.factRefs??[])) return { changed: false };
      const localAgent = required.find(row => row.participant.id === participantId)?.agent;
      if ((control.protocolVersion ?? 1) >= 6 && localAgent && ["codex", "codex-app-server", "claude-code", "generic-cli"].includes(localAgent.adapter) && (!action.baseline?.testFiles || !action.baseline.head)) throw new HttpError(422, "真实项目需由新版Connector采集Git基线及测试文件指纹后提交计划");
      const factRefs=action.factRefs??[],bindings=bindFacts(factRefs,control.facts??[]);
      if((control.protocolVersion??1)>=7&&!factsReady(factRefs,control.facts??[],control.revision)) {
        const pendingPlan={content:action.content,baseline:action.baseline??null,factRefs,bindings};
        await db.insert(lifecycleContributions).values({id:newId(),collaborationId,revision:control.revision,participantId,content:null,pendingPlan,factRefs}).onDuplicateKeyUpdate({set:{content:null,pendingPlan,factRefs,updatedAt:new Date()}});
        await scheduleFactGates(control,participantId,factRefs);return {changed:true};
      }
      await db.insert(lifecycleContributions).values({id:newId(),collaborationId,revision:control.revision,participantId,content:action.content,workspaceBaseline:action.baseline??null,factRefs,pendingPlan:null}).onDuplicateKeyUpdate({set:{content:action.content,workspaceBaseline:action.baseline??null,factRefs,pendingPlan:null,updatedAt:new Date()}});
      await finishPlanning(control,currentAgentId);
      return { changed: true };
    }
    if (action.type === "plan.compose") {
      try { action.contract = normalizeSharedContract(action.contract); } catch { throw new HttpError(422, "HTTP规范必须有效且引用完整"); }
      if (control.phase !== "plan_synthesis" || participantId !== control.requiredParticipantIds[0] || action.baseDocumentHash !== control.documentHash) throw new HttpError(409, "仅协调方可基于当前版本汇总统一契约");
      const context = (await getLifecycleContext(collaborationId))!;
      const refs=action.contract.factRefs??[],requiredRefs=[...new Set(context.contributions.flatMap(row=>row.factRefs??[]))];
      if((control.protocolVersion??1)>=7&&requiredRefs.some(key=>!refs.includes(key)))throw new HttpError(422,"共同契约不得遗漏项目分析所引用的共享事实key");
      const bindings=bindFacts(refs,control.facts??[]);
      if((control.protocolVersion??1)>=7&&!factsReady(refs,control.facts??[],control.revision)){await scheduleFactGates(control,participantId,refs);return {changed:true};}
      validateSharedContract(action.contract, control.requiredParticipantIds, context.baseline?.contract, (control.protocolVersion ?? 1) >= 6 && collaboration.type === "api-integration", (control.protocolVersion??1)>=7&&collaboration.type==="api-integration", (control.protocolVersion??1)>=8&&collaboration.type==="api-integration");
      if (revision.repair && context.baseline?.contract) validateRepairContract(context.baseline.contract, action.contract);
      const [priorRevision] = control.revision > 1 ? await db.select().from(lifecycleRevisions).where(and(eq(lifecycleRevisions.collaborationId, collaborationId), eq(lifecycleRevisions.revision, control.revision - 1))).limit(1) : [];
      executionReuse(action.contract, priorRevision, priorRevision ? await db.select().from(lifecycleContributions).where(currentContribution(collaborationId, priorRevision.revision)) : [], await getContributions(control), true);
      const rows = await requiredProjects(control);
      const document = renderSharedContract({ title: collaboration.title, revision: control.revision, requirements: revision.requirements,
        changeRequest: revision.changeRequest, contract: action.contract, previous: context.baseline?.contract,
        names: new Map(rows.map((row) => [row.participant.id, row.project.name])), baselines: context.contributions, factBindings:bindings });
      const documentHash = hash(document);
      if (documentHash === control.documentHash && (revision.objections ?? []).some((item) => item.documentHash === documentHash)) throw new HttpError(422, "该文档已有未解决异议，请实质修订契约后再提交");
      await db.update(lifecycleContributions).set({ confirmedHash: null, updatedAt: new Date() }).where(currentContribution(collaborationId, control.revision));
      await db.update(lifecycleRevisions).set({ document, documentHash, sharedContract: action.contract, factBindings:bindings, approvalIntent:null, updatedAt: new Date() }).where(eq(lifecycleRevisions.id, revision.id));
      await db.update(collaborationLifecycles).set({ phase: "plan_confirmation", documentHash, approvedHash: null, updatedAt: new Date() }).where(eq(collaborationLifecycles.collaborationId, collaborationId));
      await notify(collaborationId, "统一契约已生成。双方须检查接口语义、责任边界、联测命令和预期结果，存在冲突请提出异议。");
      return { changed: true };
    }
    if (action.type === "plan.reject") {
      if (control.phase !== "plan_confirmation" || action.documentHash !== control.documentHash) throw new HttpError(409, "只能对当前待确认文档提出异议");
      await db.update(lifecycleRevisions).set({ objections: [...(revision.objections ?? []), { participantId, documentHash: action.documentHash, reason: action.reason }].slice(-50), updatedAt: new Date() }).where(eq(lifecycleRevisions.id, revision.id));
      await db.update(lifecycleContributions).set({ confirmedHash: null, updatedAt: new Date() }).where(currentContribution(collaborationId, control.revision));
      await db.update(collaborationLifecycles).set({ phase: "plan_synthesis", updatedAt: new Date() }).where(eq(collaborationLifecycles.collaborationId, collaborationId));
      await cancelSupersededReviews(control, currentAgentId);
      await notify(collaborationId, `项目 Agent 提出契约异议：${action.reason}。协调方将修订，双方需重新确认。`);
      return { changed: true };
    }
    if (action.type === "plan.confirm") {
      if (!["plan_confirmation", "awaiting_approval"].includes(control.phase) || !control.documentHash || action.documentHash !== control.documentHash) throw new HttpError(409, "只能确认当前完整开发文档的内容哈希");
      if (!existing?.content) throw new HttpError(409, "请先提交本项目完整开发计划");
      if (existing.confirmedHash === control.documentHash) return { changed: false };
      await db.update(lifecycleContributions).set({ confirmedHash: control.documentHash, updatedAt: new Date() }).where(eq(lifecycleContributions.id, existing.id));
      const contributions = await getContributions(control);
      if (control.requiredParticipantIds.every((id) => contributions.some((row) => row.participantId === id && row.confirmedHash === control.documentHash))) {
        await db.update(collaborationLifecycles).set({ phase: "awaiting_approval", updatedAt: new Date() }).where(eq(collaborationLifecycles.collaborationId, collaborationId));
        await notify(collaborationId, `双方已确认第 ${control.revision} 版完整开发文档。请管理员阅读并确认本版内容；AI 不能自行批准实施。`);
      }
      return { changed: true };
    }
    if (!control.approvedHash || control.approvedHash !== control.documentHash) throw new HttpError(409, "本版文档未获管理员批准");
    if (action.type === "integration.report") {
      if (control.phase !== "joint_verifying" || action.documentHash !== control.approvedHash || !revision.sharedContract) throw new HttpError(409, "只能在本版联合验收阶段提交结果");
      const expected = revision.sharedContract.acceptanceCases.filter((item) => item.runnerParticipantId === participantId);
      const frozen = existing?.reportEvidence?.testFiles as import("@seam/protocol").CommandEvidence["testFiles"];
      validatePinnedTests(frozen, action.testFiles, [], participantId, true);
      for (const item of expected) for (const check of item.httpChecks ?? []) {
        const result = action.independentResults?.find(row => row.id === check.id && row.caseId === item.id);
        if (!result || result.documentHash !== control.approvedHash || result.specHash !== hash(canonicalJson(check))) throw new HttpError(422, "缺少绑定本版批准契约的独立HTTP验收记录");
        if (action.checks.find(row => row.caseId === item.id)?.status === "passed" && result.status !== "passed") throw new HttpError(422, "独立HTTP契约验收未通过，不能发布用例通过结论");
      }
      if (action.checks.length !== expected.length || new Set(action.checks.map((item) => item.caseId)).size !== action.checks.length || expected.some((item) => !action.checks.some((check) => check.caseId === item.id))) throw new HttpError(422, "必须完整报告本方所有已批准的联合验收用例，不得跨方或遗漏");
      if (action.checks.some((check) => check.status !== "not_run" && (!check.command.trim() || !Object.keys(check.evidence).length))) throw new HttpError(422, "已执行用例必须提供真实命令和证据");
      for (const check of action.checks) {
        const expectedCase = expected.find((item) => item.id === check.caseId)!;
        const required = expectedCase.requiredAssertions ?? [];
        if (check.status === "passed" && required.length && (!check.runIds.length || required.some((name) => !check.assertionNames.includes(name)))) throw new HttpError(422, "通过报告必须覆盖全部已批准的必需断言并关联实际命令");
        if (!check.runIds.length) continue; // Previously approved legacy documents remain identifiable.
        const runs = action.runs.filter((run) => check.runIds.includes(run.id));
        const approvedCommand = expected.find((item) => item.id === check.caseId)!.command.trim();
        if (new Set(action.runs.map((run) => run.id)).size !== action.runs.length || runs.length !== check.runIds.length || check.command.trim() !== approvedCommand || runs.some((run) => run.command.trim() !== approvedCommand) || !check.assertionNames.length || check.assertionNames.some((name) => !runs.some((run) => run.assertions.includes(name))) || (check.status === "passed" && runs.some((run) => run.exitCode !== 0))) throw new HttpError(422, "用例引用的批准命令、实际断言或退出码不匹配");
        if (check.status === "passed" && required.some((name) => !runs.some((run) => run.assertions.includes(name)))) throw new HttpError(422, "必需业务断言未全部实际通过");
      }
      const evidenceRuns = [...new Map([...(existing?.evidenceRuns ?? []), ...action.runs].map((run) => [run.id, run])).values()];
      const checks = action.checks.map(check => ({ ...check, category: check.category ?? (check.status === "failed" ? (control.protocolVersion ?? 1) >= 6 ? "unknown" as const : "code" as const : check.status === "not_run" ? "environment" as const : undefined) }));
      await db.update(lifecycleContributions).set({ integrationChecks: checks, evidenceRuns, reportEvidence: { ...existing?.reportEvidence, independentResults: action.independentResults ?? [] }, updatedAt: new Date() }).where(and(currentContribution(collaborationId, control.revision), eq(lifecycleContributions.participantId, participantId)));
      const contributions = await getContributions(control);
      if (control.requiredParticipantIds.every((id) => contributions.some((row) => row.participantId === id && row.integrationChecks))) await finishReport(control, revision, collaboration, contributions, currentAgentId);
      return { changed: true };
    }
    if (control.phase !== "executing") throw new HttpError(409, "当前阶段不能提交实施报告");
    validatePinnedTests(existing?.workspaceBaseline?.testFiles, action.testFiles, revision.sharedContract?.testChanges, participantId);
    const reportEvidence = { ...action.evidence, category: action.category ?? (action.status === "failed" && (control.protocolVersion ?? 1) >= 6 ? "unknown" : "code"), ...(action.testFiles ? { testFiles: action.testFiles } : {}) };
    if (existing?.reportStatus === action.status && existing.reportSummary === action.summary && JSON.stringify(existing.reportEvidence) === JSON.stringify(reportEvidence)) return { changed: false };
    await db.insert(lifecycleContributions).values({ id: newId(), collaborationId, revision: control.revision, participantId, reportStatus: action.status, reportSummary: action.summary, reportEvidence, evidenceRuns: action.runs })
      .onDuplicateKeyUpdate({ set: { reportStatus: action.status, reportSummary: action.summary, reportEvidence, evidenceRuns: action.runs, updatedAt: new Date() } });
    const contributions = await getContributions(control);
    if (control.requiredParticipantIds.every((id) => contributions.some((row) => row.participantId === id && row.reportStatus && row.reportSummary))) {
      if (contributions.some((row) => row.reportStatus === "failed") || !revision.sharedContract) await finishReport(control, revision, collaboration, contributions, currentAgentId);
      else {
        await db.update(collaborationLifecycles).set({ phase: "joint_verifying", updatedAt: new Date() }).where(eq(collaborationLifecycles.collaborationId, collaborationId));
        await notify(collaborationId, "双方实施报告已收齐，开始按批准契约进行真实联合验收；本地测试通过不代表联调通过。");
      }
    }
    return { changed: true };
  });
}

async function finishReport(control: Lifecycle, revision: Revision, collaboration: typeof collaborations.$inferSelect, contributions: Contribution[], currentAgentId: string | null) {
  const rows = await requiredProjects(control);
  const checks = contributions.flatMap((row) => row.integrationChecks ?? []);
  const expected = revision.sharedContract ? expandSharedContract(revision.sharedContract).acceptanceCases : [];
  const allPassed = expected.length > 0 && expected.every((item) => checks.some((check) => check.caseId === item.id && check.status === "passed"));
  const rootCauses = failureOverview(revision.sharedContract, contributions.map(row => ({participantId:row.participantId,independentResults:(row.reportEvidence?.independentResults ?? []) as NonNullable<NonNullable<LifecycleContext["baseline"]>["failureDigest"]>[number]["independentResults"]})));
  const rootName = (id:string|null) => { const row=rows.find(item=>item.participant.id===id);return row?`${row.project.name} / ${row.agent?.name ?? "Agent"}`:id??"未发布服务"; };
  const safeCell = (value:string|undefined) => (value??"无").replaceAll("|", "\\|").replaceAll("\n", " ");
  const report = [
    `# ${collaboration.title}：完整实施报告（第 ${control.revision} 版）`, `开发文档哈希：${control.approvedHash}`,
    `## 验收概览\n\n本地实施：${contributions.some((row) => row.reportStatus === "failed") ? "存在失败或阻塞" : "双方已报告完成"}\n\n联合验证：${allPassed ? "全部用例报告通过" : checks.length ? "存在失败或未执行用例" : "未执行，不能宣称联调通过"}\n\n管理员验收（报告生成时）：待人工审阅。`,
    `## 失败根因概览\n\n${rootCauses.length ? "| 失败要求 | 服务所属项目 / Agent | 请求与字段 | 期望 | 实际 | 观察方与检查 |\n|---|---|---|---|---|---|\n" + rootCauses.map(cause => `| ${safeCell(cause.requirementIds.join("、"))} | ${safeCell(rootName(cause.publisherParticipantId))} | ${safeCell(`${cause.service} ${cause.request} ${cause.path}`)} | ${safeCell(cause.expected)} | ${safeCell(cause.actual)} | ${safeCell(`${rootName(cause.observerParticipantId)} ${cause.caseId}/${cause.checkId}`)} |`).join("\n") : "没有固定HTTP失败；命令或未执行原因见各方联合验证记录。"}`,
    ...rows.map((row) => {
      const result = contributions.find((item) => item.participantId === row.participant.id)!;
      return `## ${row.project.name}：${result.reportStatus === "passed" ? "本地实施报告通过" : "存在失败或阻塞"}\n\n${result.reportSummary}\n\n### 实际证据\n\n${JSON.stringify(result.reportEvidence ?? {}, null, 2)}\n\n### 联合验证\n\n${(result.integrationChecks ?? []).map((check) => `${check.caseId}：${check.status}\n命令：${check.command}\n${check.summary}\n证据来源：${check.runIds?.length ? `Connector采集 ${check.runIds.join("、")}；断言：${check.assertionNames.join("、")}` : "Agent回报，未关联自动采集的断言记录"}\n${JSON.stringify(check.evidence, null, 2)}`).join("\n\n") || "未执行"}\n\n### 命令原始记录（每次执行仅归档一份）\n\n${(result.evidenceRuns ?? []).map((run) => `${run.id} · ${run.command} · exit=${run.exitCode}\n${run.output}`).join("\n\n")}`;
    }),
    "## 管理员后续操作\n\n可补充要求启动下一版增量协商，或在审阅证据并满意后手动终止。失败与未执行结果会保留，报告收齐不代表自动验收。",
  ].join("\n\n");
  await db.update(lifecycleRevisions).set({ report, updatedAt: new Date() }).where(eq(lifecycleRevisions.id, revision.id));
  const failures = repairFailures(contributions);
  if (failures.length) {
    const next = control.revision + 1;
    const repair = { sourceRevision: control.revision, sourceDocumentHash: control.approvedHash, sourceReportHash: hash(report), cycle: (revision.repair?.cycle ?? 0) + 1, failures };
    const requirements = `修复第${control.revision}版已报告的实施或联调未通过项；沿用上版有效业务目标与验收覆盖，先只读分析原始证据，协商完整修复方案并由双方确认。管理员批准新文档后才允许重新实施和运行验证。\n${failures.map(row => `${row.participantId} / ${row.caseId ?? row.stage} / ${row.status}：${row.summary}`).join("\n")}`;
    await db.insert(lifecycleRevisions).values({ id: newId(), collaborationId: control.collaborationId, revision: next, requirements, changeRequest: requirements, repair, createdById: collaboration.createdById });
    await db.update(collaborationLifecycles).set({ revision: next, phase: "planning", documentHash: null, approvedHash: null, approvedById: null, approvedAt: null, protocolVersion: CONNECTOR_PROTOCOL_VERSION, updatedAt: new Date() }).where(eq(collaborationLifecycles.collaborationId, control.collaborationId));
    const oldJobs = await db.select().from(connectorJobs).where(and(eq(connectorJobs.collaborationId, control.collaborationId), inArray(connectorJobs.status, ["pending", "running"])));
    for (const job of oldJobs) if (job.agentId !== currentAgentId) await db.update(connectorJobs).set({ status: "cancelled", error: "本轮失败报告已归档，进入只读修复方案起草；新方案未批准不得实施", leaseUntil: null, updatedAt: new Date() }).where(eq(connectorJobs.id, job.id));
    await db.update(collaborations).set({ status: "negotiating", updatedAt: new Date() }).where(eq(collaborations.id, control.collaborationId));
    await audit({ collaborationId: control.collaborationId, actorType: "system", actorId: "seam", action: "lifecycle.repair_drafted", metadata: { revision: next, ...repair } });
    await notify(control.collaborationId, `第${control.revision}版存在未通过项，完整失败报告已保存。双方正在只读起草第${next}版修复方案；管理员批准前不会重新实施或验证。`);
    await queueWorkflowWakeup(control.collaborationId);
    return;
  }
  const blocked = contributions.filter(row => row.reportStatus === "failed" || row.integrationChecks?.some(check => check.status !== "passed"));
  if (blocked.length) {
    for (const row of blocked) {
      const check = row.integrationChecks?.find(item => item.status !== "passed");
      const category = check?.category ?? row.reportEvidence?.category ?? (check?.status === "not_run" ? "environment" : "unknown");
      const reason = `${category === "environment" ? "服务或运行环境未就绪" : category === "authorization" ? "本机权限不足" : category === "missing_information" ? "必要事实不足" : "失败原因尚未确定"}：${check?.summary ?? row.reportSummary}；本轮未通过，管理员确认前不重新实施或验证。`.slice(0, 5000);
      if (category === "missing_information" || category === "unknown") await beginInformationLookup(control, row.participantId, reason, undefined, { resumeRequiresReview: true, purpose:category==="unknown"?"diagnostic":"fact" });
      else await db.update(lifecycleContributions).set({ block: { kind: "needs_admin", requiresReview: true, requiresAuthorization: category === "authorization", category: category as "environment" | "authorization" | "unknown", reason, phase: control.phase, attempts: 1, retryAt: null, retryAfterSeconds: 5, dependencyParticipantIds: [] }, updatedAt: new Date() }).where(eq(lifecycleContributions.id, row.id));
    }
    await db.update(collaborations).set({ status: "in_progress", updatedAt: new Date() }).where(eq(collaborations.id, control.collaborationId));
    await notify(control.collaborationId, "本轮存在环境、权限、事实不足或未执行结果，原始证据已归档；先处理实际原因，等待管理员确认重试，不自动创建代码修复版。");
    return;
  }
  await db.update(collaborationLifecycles).set({ phase: "awaiting_review", updatedAt: new Date() }).where(eq(collaborationLifecycles.collaborationId, control.collaborationId));
  await db.update(collaborations).set({ status: "validating", updatedAt: new Date() }).where(eq(collaborations.id, control.collaborationId));
  await notify(control.collaborationId, "本轮实施与联合验证结果已汇总，等待管理员审阅；任务不会自行结束。");
}

export async function approveLifecycle(userId: string, collaborationId: string, input: { revision: number; documentHash: string }): Promise<LifecycleContext> {
  return locked(collaborationId, async (control) => {
    await requireAdministrator(userId, collaborationId);
    if (!control || control.pausedAt || control.revision !== input.revision || control.phase !== "awaiting_approval" || control.documentHash !== input.documentHash) throw new HttpError(409, "文档版本、内容或阶段已变化，请重新阅读当前完整文档再确认");
    const revision = await getRevision(control);
    if (!revision.document || hash(revision.document) !== input.documentHash) throw new HttpError(409, "开发文档内容与哈希不符，不能授权实施");
    const contributions = await getContributions(control);
    if (!control.requiredParticipantIds.every((id) => contributions.some((row) => row.participantId === id && row.confirmedHash === input.documentHash))) throw new HttpError(409, "尚未收齐双方对当前文档的确认");
    await requiredProjects(control);
    const refs=revision.sharedContract?.factRefs??[];
    if((control.protocolVersion??1)>=7&&!factsReady(refs,control.facts??[],control.revision)) {
      await db.update(lifecycleRevisions).set({approvalIntent:{userId,documentHash:input.documentHash,requestedAt:new Date().toISOString()},updatedAt:new Date()}).where(eq(lifecycleRevisions.id,revision.id));
      await scheduleFactGates(control,control.requiredParticipantIds[0]!,refs);
      await audit({collaborationId,actorType:"user",actorId:userId,action:"lifecycle.approval_requested",metadata:input});
      return (await getLifecycleContext(collaborationId))!;
    }
    if((control.protocolVersion??1)>=7&&!sameBindings(revision.factBindings??[],bindFacts(refs,control.facts??[])))throw new HttpError(409,"文档引用的事实已变化，不能沿用旧文档批准");
    await commitLifecycleApproval(userId,control,input.documentHash);
    return (await getLifecycleContext(collaborationId))!;
  });
}

export async function retryLifecycleValidation(userId: string, collaborationId: string, input: { revision: number; documentHash: string }) {
  return locked(collaborationId, async control => {
    await requireAdministrator(userId, collaborationId);
    if (!control || control.pausedAt || !["executing", "joint_verifying"].includes(control.phase) || control.revision !== input.revision || control.documentHash !== input.documentHash || control.approvedHash !== input.documentHash) throw new HttpError(409, "重试必须绑定当前已批准的完整文档和修订");
    const revision = await getRevision(control), rows = await getContributions(control);
    if (!rows.some(row => row.block?.requiresReview) || rows.some(row => row.block?.kind === "gathering_info")) throw new HttpError(409, "尚无可确认重试项，或缺失事实仍在查找中");
    if (rows.some(row => row.block?.requiresReview && row.block.category === "code")) throw new HttpError(409, "代码或测试资料指纹变化须先重新起草修复方案并批准，不能用环境重试绕过");
    const history = [...(revision.attemptHistory ?? []), { id: newId(), phase: control.phase, report: revision.report ?? rows.filter(row => row.block).map(row => row.block!.reason).join("\n"), createdAt: new Date().toISOString(), approvedById: userId }];
    if (history.length > 100) throw new HttpError(409, "本轮重试归档已达上限，请审阅后在新修订中调整方案");
    await db.update(lifecycleRevisions).set({ attemptHistory: history, report: null, informationRequests: (revision.informationRequests ?? []).map(row => row.status === "answered" && row.resumeRequiresReview ? { ...row, reviewApprovedAt: new Date().toISOString() } : row), updatedAt: new Date() }).where(eq(lifecycleRevisions.id, revision.id));
    for (const row of rows.filter(item => item.block?.requiresReview)) await db.update(lifecycleContributions).set({ block: null, ...(control.phase === "executing" ? { reportStatus: null, reportSummary: null, reportEvidence: null, evidenceRuns: null } : { integrationChecks: null }), updatedAt: new Date() }).where(eq(lifecycleContributions.id, row.id));
    await db.update(collaborations).set({ status: "in_progress", updatedAt: new Date() }).where(eq(collaborations.id, collaborationId));
    await audit({ collaborationId, actorType: "user", actorId: userId, action: "lifecycle.retry_approved", metadata: input });
    await notify(collaborationId, "管理员已确认环境/权限/事实处理后按原批准文档重试；失败证据另行归档，没有提升本机权限或改变业务目标。");
    await queueWorkflowWakeup(collaborationId);
    return (await getLifecycleContext(collaborationId))!;
  });
}

export async function appendLifecycleRequirements(userId: string, collaborationId: string, input: { requirements: string }): Promise<LifecycleContext> {
  const requirements = input.requirements.trim();
  if (!requirements || requirements.length > 50_000) throw new HttpError(422, "追加要求不能为空且不得超过 50000 字符");
  return locked(collaborationId, async (control) => {
    await requireAdministrator(userId, collaborationId);
    const blockedCode = control && ["executing", "joint_verifying"].includes(control.phase) ? (await getContributions(control)).filter(row => row.block?.requiresReview && row.block.category === "code") : [];
    if (!control || (!["awaiting_review", "awaiting_approval"].includes(control.phase) && !blockedCode.length)) throw new HttpError(409, "请在报告收齐、文档待确认或未获授权的代码/测试变化待审阅时重新起草");
    const revision = control.revision + 1;
    await requiredProjects(control);
    const previous = await getRevision(control), sourceReport = previous.report ?? `# 未获批准的代码或测试变化\n${blockedCode.map(row => row.block!.reason).join("\n\n")}\n本轮验收未完成，不得宣称通过。`;
    if (blockedCode.length && !previous.report) await db.update(lifecycleRevisions).set({ report: sourceReport, updatedAt: new Date() }).where(eq(lifecycleRevisions.id, previous.id));
    await db.insert(lifecycleRevisions).values({ id: newId(), collaborationId, revision,
        requirements, changeRequest: requirements, createdById: userId,
        ...(blockedCode.length ? { repair: { sourceRevision: control.revision, sourceDocumentHash: control.approvedHash, sourceReportHash: hash(sourceReport), cycle: (previous.repair?.cycle ?? 0) + 1,
          failures: blockedCode.map(row => ({ participantId: row.participantId, stage: control.phase as "executing" | "joint_verifying", caseId: null, status: "failed" as const, summary: row.block!.reason })) } } : {}),
    });
    await db.update(collaborationLifecycles).set({ revision, phase: "planning", documentHash: null, approvedHash: null, approvedById: null, approvedAt: null, updatedAt: new Date() })
      .where(eq(collaborationLifecycles.collaborationId, collaborationId));
    await db.update(connectorJobs).set({ status: "cancelled", error: "管理员追加要求，旧修订任务已失效", leaseUntil: null, updatedAt: new Date() }).where(and(
      eq(connectorJobs.collaborationId, collaborationId), eq(connectorJobs.kind, "collaboration.turn"), inArray(connectorJobs.status, ["pending", "running"]),
    ));
    await db.update(collaborations).set({ status: "negotiating", updatedAt: new Date() }).where(eq(collaborations.id, collaborationId));
    await notify(collaborationId, `管理员已追加第 ${revision} 版要求。双方将重新协商完整开发文档，旧版执行授权不适用于新版。`);
    await audit({ collaborationId, actorType: "user", actorId: userId, action: "lifecycle.requirements_appended", metadata: { revision } });
    await queueWorkflowWakeup(collaborationId);
    return (await getLifecycleContext(collaborationId))!;
  });
}

export async function terminateLifecycle(userId: string, collaborationId: string, input: { revision?: number; decision?: "accepted" | "stopped"; reportHash?: string | null } = {}): Promise<LifecycleContext> {
  return locked(collaborationId, async (control) => {
    await requireAdministrator(userId, collaborationId);
    const revision = control ? await getRevision(control) : null;
    const abandoningRepair = revision?.repair && !control?.approvedHash && ["planning", "plan_synthesis", "plan_confirmation", "awaiting_approval"].includes(control!.phase);
    const abandoningReview = control && (await getContributions(control)).some(row => row.block?.requiresReview);
    if (!control || (input.revision !== undefined && control.revision !== input.revision) || (control.phase !== "awaiting_review" && !abandoningRepair && !abandoningReview)) throw new HttpError(409, "仅能在报告收齐、失败待确认或修复草案尚未执行时，由管理员手动终止协作");
    if ((control.protocolVersion ?? 1) >= 9 && (!input.decision || input.reportHash === undefined)) throw new HttpError(422, "请明确选择满意验收或停止任务，并提交当前报告指纹");
    const contributions = await getContributions(control), cases = revision?.sharedContract?.acceptanceCases ?? [];
    const canAccept = control.phase === "awaiting_review" && !abandoningReview && cases.length > 0 && control.requiredParticipantIds.every(id => contributions.some(row => row.participantId === id && row.reportStatus === "passed")) && cases.every(item => contributions.some(row => row.participantId === item.runnerParticipantId && row.integrationChecks?.some(check => check.caseId === item.id && check.status === "passed")));
    const sealed = sealFinalDecision({ revision: control.revision, documentHash: control.approvedHash, report: revision!.report, reviewedHash: input.reportHash === undefined ? (revision!.report ? hash(revision!.report) : null) : input.reportHash, outcome: input.decision ?? (canAccept ? "accepted" : "stopped"), userId, canAccept });
    await db.update(lifecycleRevisions).set({ report: sealed.report, updatedAt: new Date() }).where(eq(lifecycleRevisions.id, revision!.id));
    await db.update(collaborationLifecycles).set({ phase: "terminated", finalDecision: sealed.decision, terminatedById: userId, terminatedAt: new Date(), updatedAt: new Date() })
      .where(eq(collaborationLifecycles.collaborationId, collaborationId));
    await db.update(connectorJobs).set({ status: "cancelled", error: "管理员已终止协作", leaseUntil: null, updatedAt: new Date() }).where(and(
      eq(connectorJobs.collaborationId, collaborationId), eq(connectorJobs.kind, "collaboration.turn"), inArray(connectorJobs.status, ["pending", "running"]),
    ));
    await db.update(collaborations).set({ status: "completed", updatedAt: new Date() }).where(eq(collaborations.id, collaborationId));
    await notify(collaborationId, abandoningRepair ? `管理员已终止第${control.revision}版未执行的修复草案，原始失败证据已保留。` : `管理员已审阅第 ${control.revision} 版实施报告并手动终止协作。后续自动派发与旧任务回传均停止。`);
    await audit({ collaborationId, actorType: "user", actorId: userId, action: "lifecycle.terminated", metadata: sealed.decision });
    return (await getLifecycleContext(collaborationId))!;
  });
}

export async function pauseLifecycle(userId: string, collaborationId: string, paused: boolean, resolution?: string): Promise<LifecycleContext> {
  return locked(collaborationId, async (control) => {
    await requireAdministrator(userId, collaborationId);
    if (!control || control.phase === "terminated") throw new HttpError(409, "已终止或未开始的协作不能暂停或恢复");
    const blocks = (await getContributions(control)).filter((row) => row.block);
    if (Boolean(control.pausedAt) === paused && (paused || !blocks.length)) return (await getLifecycleContext(collaborationId))!;
    if (!paused && blocks.some((row) => row.block?.kind === "needs_admin" && !row.block.requiresReview) && !resolution?.trim()) throw new HttpError(422, "请补充阻塞所缺的必要事实后继续；需求变更须重新起草文档");
    if (!paused) {
      const revision = await getRevision(control);
      if (resolution?.trim()) {
        const missing = (revision.informationRequests ?? []).filter(row => row.status === "needs_admin");
        if (missing.length > 1) throw new HttpError(422, "请按问题分别补充事实，不能用同一段文字覆盖多个缺失或冲突事实");
        await db.update(lifecycleRevisions).set({ informationRequests: (revision.informationRequests ?? []).map(row => row.status === "needs_admin" ? { ...row, status: "answered" as const, answer: resolution.trim(), administratorResolution: { answer: resolution.trim(), providedAt: new Date().toISOString() } } : row), updatedAt: new Date() }).where(eq(lifecycleRevisions.id, revision.id));
        if (missing.length) { const fact = administratorFact(missing[0]!, resolution.trim()); await db.update(collaborationLifecycles).set({ facts: [...(control.facts ?? []).filter(row => row.key !== fact.key), fact].slice(-200), updatedAt: new Date() }).where(eq(collaborationLifecycles.collaborationId, collaborationId)); }
      }
      for (const row of blocks) {
        const request = revision.informationRequests?.find(item => item.id === row.block?.informationRequestId);
        const needsReview = row.block?.requiresReview || request?.resumeRequiresReview;
        await db.update(lifecycleContributions).set({ block: needsReview ? { ...row.block!, kind: "needs_admin", requiresReview: true, reason: "失败后的必要事项已补充，仍需管理员确认重试实施或验证。" } : row.block?.kind === "gathering_info" ? row.block : null, updatedAt: new Date() }).where(eq(lifecycleContributions.id, row.id));
      }
      if (resolution?.trim()) await db.insert(messages).values({ id: newId(), collaborationId, authorType: "user", authorName: "管理员补充事实", kind: "clarification", body: resolution.trim().slice(0, 5000), metadata: { blockResolution: true, dispatch: false } });
    }
    await db.update(collaborationLifecycles).set({ pausedAt: paused ? new Date() : null, updatedAt: new Date() }).where(eq(collaborationLifecycles.collaborationId, collaborationId));
    if (paused) await db.update(connectorJobs).set({ status: "cancelled", error: "管理员暂停协作，等待执行端停止确认", leaseUntil: null, updatedAt: new Date() }).where(and(eq(connectorJobs.collaborationId, collaborationId), inArray(connectorJobs.status, ["pending", "running"])));
    else await queueWorkflowWakeup(collaborationId);
    await notify(collaborationId, paused ? "管理员已暂停协作，正在通知本机停止。已产生的文件修改不会自动撤销。" : "管理员已恢复协作，双方将核对现状后继续未完成阶段。");
    await audit({ collaborationId, actorType: "user", actorId: userId, action: paused ? "lifecycle.paused" : "lifecycle.resumed" });
    return (await getLifecycleContext(collaborationId))!;
  });
}

/** Called under the collaboration scheduling lock; repeated wakeups are idempotent. */
export async function recordRetryBudgetStop(collaborationId: string, input: {
  revision: number; phase: string; participantId: string; generation: number; used: number; limit: number;
}) {
  return locked(collaborationId, async control => {
    if (!control || control.revision !== input.revision || control.phase !== input.phase || !control.requiredParticipantIds.includes(input.participantId)) return;
    const revision = await getRevision(control), state = revision.retryBudget ?? { grants: [], stops: [] };
    if (state.stops.some(row => row.participantId === input.participantId && row.phase === input.phase && row.generation === input.generation)) return;
    const stop = { ...input, stoppedAt: new Date().toISOString(), reason: `本端本阶段已使用 ${input.used}/${input.limit} 次自动推进预算。请管理员核对记录后授权新的有界重试；原文档及批准范围保持有效。` };
    await db.update(lifecycleRevisions).set({ retryBudget: { ...state, stops: [...state.stops, stop] }, updatedAt: new Date() }).where(eq(lifecycleRevisions.id, revision.id));
    await audit({ collaborationId, actorType: "system", actorId: "seam", action: "lifecycle.retry_budget_exhausted", metadata: stop });
  });
}

export async function grantRetryBudget(userId: string, collaborationId: string, input: {
  revision: number; phase: string; participantId: string; generation: number; reason: string;
}) {
  return locked(collaborationId, async control => {
    await requireAdministrator(userId, collaborationId);
    if (!control || control.pausedAt || control.revision !== input.revision || control.phase !== input.phase || control.phase === "terminated") throw new HttpError(409, "当前阶段或修订已变化，不能恢复旧预算");
    const revision = await getRevision(control), state = revision.retryBudget ?? { grants: [], stops: [] };
    const stop = state.stops.find(row => row.participantId === input.participantId && row.phase === input.phase && row.generation === input.generation);
    if (!stop || input.reason.trim().length < 10 || input.reason.length > 1000) throw new HttpError(409, "只能为当前已耗尽的预算授权，重复或旧授权不会生效");
    const [latest] = await db.select().from(connectorJobs).where(eq(connectorJobs.collaborationId, collaborationId)).orderBy(desc(connectorJobs.sequence)).limit(1);
    const grant = { participantId: input.participantId, phase: input.phase, generation: input.generation + 1, afterSequence: latest?.sequence ?? 0, grantedById: userId, grantedAt: new Date().toISOString(), reason: input.reason.trim() };
    await db.update(lifecycleRevisions).set({ retryBudget: { grants: [...state.grants, grant], stops: state.stops.filter(row => row !== stop) }, updatedAt: new Date() }).where(eq(lifecycleRevisions.id, revision.id));
    await audit({ collaborationId, actorType: "user", actorId: userId, action: "lifecycle.retry_budget_granted", metadata: grant });
    const owner = (await requiredProjects(control)).find(row => row.participant.id === input.participantId)!;
    await notify(collaborationId, `管理员已为 ${owner.project.name} / ${owner.agent?.name ?? input.participantId} 授权新一轮有界重试：${grant.reason}`);
    await queueWorkflowWakeup(collaborationId);
    return (await getLifecycleContext(collaborationId))!;
  });
}
