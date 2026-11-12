import { createHash } from "node:crypto";
import { and, asc, eq, inArray } from "drizzle-orm";
import { lifecycleAgentActionSchema, type LifecycleAgentAction, type LifecycleContext } from "@seam/protocol";
import { db, withTransaction } from "@/db";
import {
  agents, collaborations, collaborationLifecycles, connectorJobs, lifecycleContributions,
  lifecycleRevisions, messages, participants, projects,
} from "@/db/schema";
import { requireCollaborationAccess } from "@/lib/access";
import { audit } from "@/lib/audit";
import { HttpError } from "@/lib/http";
import { newId } from "@/lib/ids";
import { renderSharedContract, validateSharedContract } from "@/lib/lifecycle-contract";
import { queueWorkflowWakeup } from "./workflow-outbox";
import { authorizeActor, type Actor } from "./actor";

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

function contextFrom(control: Lifecycle, revision: Revision, contributions: Contribution[], previous?: Revision): LifecycleContext {
  const relevant = contributions.filter((row) => control.requiredParticipantIds.includes(row.participantId));
  return {
    revision: control.revision, phase: control.phase, requirements: revision.requirements,
    document: revision.document, documentHash: control.documentHash, approvedHash: control.approvedHash,
    requiredParticipantIds: control.requiredParticipantIds, coordinatorParticipantId: control.requiredParticipantIds[0], paused: Boolean(control.pausedAt),
    changeRequest: revision.changeRequest, contract: revision.sharedContract, objections: revision.objections ?? [],
    baseline: previous ? { revision: previous.revision, documentHash: previous.documentHash, document: previous.sharedContract ? null : previous.document, contract: previous.sharedContract, report: previous.report } : null,
    contributions: relevant.flatMap((row) => row.content ? [{ participantId: row.participantId, content: row.content, baseline: row.workspaceBaseline ?? null }] : []),
    confirmations: relevant.filter((row) => control.documentHash && row.confirmedHash === control.documentHash).map((row) => row.participantId),
    reports: relevant.flatMap((row) => row.reportStatus && row.reportSummary ? [{
      participantId: row.participantId, status: row.reportStatus, summary: row.reportSummary, evidence: row.reportEvidence ?? {},
    }] : []),
    integrationReports: relevant.flatMap((row) => row.integrationChecks ? [{ participantId: row.participantId, checks: row.integrationChecks }] : []),
    report: revision.report,
  };
}

export async function getLifecycleContext(collaborationId: string): Promise<LifecycleContext | null> {
  const control = await getControl(collaborationId);
  if (!control) return null;
  const [previous] = control.revision > 1 ? await db.select().from(lifecycleRevisions).where(and(eq(lifecycleRevisions.collaborationId, collaborationId), eq(lifecycleRevisions.revision, control.revision - 1))).limit(1) : [];
  return contextFrom(control, await getRevision(control), await getContributions(control), previous);
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

async function notify(collaborationId: string, body: string) {
  await db.insert(messages).values({ id: newId(), collaborationId, authorType: "system", authorName: "Seam", kind: "system", body });
  await db.update(collaborations).set({ updatedAt: new Date() }).where(eq(collaborations.id, collaborationId));
}

async function locked<T>(collaborationId: string, run: (control: Lifecycle | null, collaboration: typeof collaborations.$inferSelect) => Promise<T>) {
  return withTransaction(async () => {
    const [collaboration] = await db.select().from(collaborations).where(eq(collaborations.id, collaborationId)).limit(1).for("update");
    if (!collaboration) throw new HttpError(404, "协作不存在");
    return run(await getControl(collaborationId), collaboration);
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
  return required;
}

export async function startLifecycle(userId: string, collaborationId: string): Promise<LifecycleContext> {
  return locked(collaborationId, async (control, collaboration) => {
    await requireAdministrator(userId, collaborationId);
    if (control) return (await getLifecycleContext(collaborationId))!;
    const active = await db.select().from(participants).where(and(eq(participants.collaborationId, collaborationId), eq(participants.status, "active"))).orderBy(asc(participants.createdAt), asc(participants.id));
    const requiredParticipantIds = active.map((participant) => participant.id);
    await requiredProjects({ collaborationId, requiredParticipantIds }, true);
    await db.insert(collaborationLifecycles).values({ collaborationId, requiredParticipantIds, revision: 1, phase: "planning" });
    await db.insert(lifecycleRevisions).values({ id: newId(), collaborationId, revision: 1, requirements: collaboration.objective, createdById: userId });
    await db.update(collaborations).set({ status: "negotiating", updatedAt: new Date() }).where(eq(collaborations.id, collaborationId));
    await notify(collaborationId, "目标已提交。双方 AI 将先协商共同开发文档；管理员确认指定版本和内容后才会执行开发。");
    await audit({ collaborationId, actorType: "user", actorId: userId, action: "lifecycle.started", metadata: { revision: 1, requiredParticipantIds } });
    await queueWorkflowWakeup(collaborationId);
    return (await getLifecycleContext(collaborationId))!;
  });
}

export async function applyLifecycleAction(actor: Actor, collaborationId: string, rawAction: LifecycleAgentAction): Promise<{ changed: boolean }> {
  const action = lifecycleAgentActionSchema.parse(rawAction);
  return locked(collaborationId, async (control, collaboration) => {
    if (!control) throw new HttpError(409, "该协作尚未启用管理员确认开发流程");
    const participantId = await authorizeActor(actor, collaborationId);
    if (!participantId || actor.kind !== "participant" || !control.requiredParticipantIds.includes(participantId)) throw new HttpError(403, "仅本轮指定的项目 Agent 可提交计划、确认或实施报告");
    if (control.pausedAt || action.revision !== control.revision || control.phase === "terminated") throw new HttpError(409, "协作修订已失效或已终止");
    await requiredProjects(control);
    const revision = await getRevision(control);
    const existing = (await getContributions(control)).find((row) => row.participantId === participantId);
    if (action.type === "plan.submit") {
      if (!["planning", "plan_synthesis", "plan_confirmation"].includes(control.phase)) throw new HttpError(409, "当前阶段不能修改开发文档");
      if (existing?.content === action.content && JSON.stringify(existing.workspaceBaseline ?? null) === JSON.stringify(action.baseline ?? null)) return { changed: false };
      await db.insert(lifecycleContributions).values({ id: newId(), collaborationId, revision: control.revision, participantId, content: action.content, workspaceBaseline: action.baseline ?? null })
        .onDuplicateKeyUpdate({ set: { content: action.content, workspaceBaseline: action.baseline ?? null, updatedAt: new Date() } });
      const contributions = await getContributions(control);
      const allSubmitted = control.requiredParticipantIds.every((id) => contributions.some((row) => row.participantId === id && row.content));
      await db.update(lifecycleContributions).set({ confirmedHash: null, updatedAt: new Date() }).where(currentContribution(collaborationId, control.revision));
      await db.update(lifecycleRevisions).set({ document: null, documentHash: null, sharedContract: null, updatedAt: new Date() }).where(eq(lifecycleRevisions.id, revision.id));
      await db.update(collaborationLifecycles).set({ phase: allSubmitted ? "plan_synthesis" : "planning", documentHash: null, approvedHash: null, approvedById: null, approvedAt: null, updatedAt: new Date() })
        .where(eq(collaborationLifecycles.collaborationId, collaborationId));
      await notify(collaborationId, allSubmitted ? "各方分析已收齐，由协调方 Agent 汇总唯一接口契约、责任和联合验收用例。" : "已收到本方分析，等待其他项目补齐。");
      return { changed: true };
    }
    if (action.type === "plan.compose") {
      if (control.phase !== "plan_synthesis" || participantId !== control.requiredParticipantIds[0] || action.baseDocumentHash !== control.documentHash) throw new HttpError(409, "仅协调方可基于当前版本汇总统一契约");
      validateSharedContract(action.contract, control.requiredParticipantIds);
      const context = (await getLifecycleContext(collaborationId))!;
      const rows = await requiredProjects(control);
      const document = renderSharedContract({ title: collaboration.title, revision: control.revision, requirements: revision.requirements,
        changeRequest: revision.changeRequest, contract: action.contract, previous: context.baseline?.contract,
        names: new Map(rows.map((row) => [row.participant.id, row.project.name])), baselines: context.contributions });
      const documentHash = hash(document);
      if (documentHash === control.documentHash && (revision.objections ?? []).some((item) => item.documentHash === documentHash)) throw new HttpError(422, "该文档已有未解决异议，请实质修订契约后再提交");
      await db.update(lifecycleContributions).set({ confirmedHash: null, updatedAt: new Date() }).where(currentContribution(collaborationId, control.revision));
      await db.update(lifecycleRevisions).set({ document, documentHash, sharedContract: action.contract, updatedAt: new Date() }).where(eq(lifecycleRevisions.id, revision.id));
      await db.update(collaborationLifecycles).set({ phase: "plan_confirmation", documentHash, approvedHash: null, updatedAt: new Date() }).where(eq(collaborationLifecycles.collaborationId, collaborationId));
      await notify(collaborationId, "统一契约已生成。双方须检查接口语义、责任边界、联测命令和预期结果，存在冲突请提出异议。");
      return { changed: true };
    }
    if (action.type === "plan.reject") {
      if (control.phase !== "plan_confirmation" || action.documentHash !== control.documentHash) throw new HttpError(409, "只能对当前待确认文档提出异议");
      await db.update(lifecycleRevisions).set({ objections: [...(revision.objections ?? []), { participantId, documentHash: action.documentHash, reason: action.reason }].slice(-50), updatedAt: new Date() }).where(eq(lifecycleRevisions.id, revision.id));
      await db.update(lifecycleContributions).set({ confirmedHash: null, updatedAt: new Date() }).where(currentContribution(collaborationId, control.revision));
      await db.update(collaborationLifecycles).set({ phase: "plan_synthesis", updatedAt: new Date() }).where(eq(collaborationLifecycles.collaborationId, collaborationId));
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
      if (action.checks.length !== expected.length || new Set(action.checks.map((item) => item.caseId)).size !== action.checks.length || expected.some((item) => !action.checks.some((check) => check.caseId === item.id))) throw new HttpError(422, "必须完整报告本方所有已批准的联合验收用例，不得跨方或遗漏");
      if (action.checks.some((check) => check.status !== "not_run" && (!check.command.trim() || !Object.keys(check.evidence).length))) throw new HttpError(422, "已执行用例必须提供真实命令和证据");
      await db.update(lifecycleContributions).set({ integrationChecks: action.checks, updatedAt: new Date() }).where(and(currentContribution(collaborationId, control.revision), eq(lifecycleContributions.participantId, participantId)));
      const contributions = await getContributions(control);
      if (control.requiredParticipantIds.every((id) => contributions.some((row) => row.participantId === id && row.integrationChecks))) await finishReport(control, revision, collaboration.title, contributions);
      return { changed: true };
    }
    if (control.phase !== "executing") throw new HttpError(409, "当前阶段不能提交实施报告");
    if (existing?.reportStatus === action.status && existing.reportSummary === action.summary && JSON.stringify(existing.reportEvidence) === JSON.stringify(action.evidence)) return { changed: false };
    await db.insert(lifecycleContributions).values({ id: newId(), collaborationId, revision: control.revision, participantId, reportStatus: action.status, reportSummary: action.summary, reportEvidence: action.evidence })
      .onDuplicateKeyUpdate({ set: { reportStatus: action.status, reportSummary: action.summary, reportEvidence: action.evidence, updatedAt: new Date() } });
    const contributions = await getContributions(control);
    if (control.requiredParticipantIds.every((id) => contributions.some((row) => row.participantId === id && row.reportStatus && row.reportSummary))) {
      if (contributions.some((row) => row.reportStatus === "failed") || !revision.sharedContract) await finishReport(control, revision, collaboration.title, contributions);
      else {
        await db.update(collaborationLifecycles).set({ phase: "joint_verifying", updatedAt: new Date() }).where(eq(collaborationLifecycles.collaborationId, collaborationId));
        await notify(collaborationId, "双方实施报告已收齐，开始按批准契约进行真实联合验收；本地测试通过不代表联调通过。");
      }
    }
    return { changed: true };
  });
}

async function finishReport(control: Lifecycle, revision: Revision, title: string, contributions: Contribution[]) {
  const rows = await requiredProjects(control);
  const checks = contributions.flatMap((row) => row.integrationChecks ?? []);
  const expected = revision.sharedContract?.acceptanceCases ?? [];
  const allPassed = expected.length > 0 && expected.every((item) => checks.some((check) => check.caseId === item.id && check.status === "passed"));
  const report = [
    `# ${title}：完整实施报告（第 ${control.revision} 版）`, `开发文档哈希：${control.approvedHash}`,
    `## 验收概览\n\n本地实施：${contributions.some((row) => row.reportStatus === "failed") ? "存在失败或阻塞" : "双方已报告完成"}\n\n联合验证：${allPassed ? "全部用例报告通过" : checks.length ? "存在失败或未执行用例" : "未执行，不能宣称联调通过"}\n\n管理员验收：待人工审阅，未自动接受。`,
    ...rows.map((row) => {
      const result = contributions.find((item) => item.participantId === row.participant.id)!;
      return `## ${row.project.name}：${result.reportStatus === "passed" ? "报告通过" : "存在失败或阻塞"}\n\n${result.reportSummary}\n\n### 实际证据\n\n${JSON.stringify(result.reportEvidence ?? {}, null, 2)}\n\n### 联合验证\n\n${(result.integrationChecks ?? []).map((check) => `${check.caseId}：${check.status}\n命令：${check.command}\n${check.summary}\n${JSON.stringify(check.evidence, null, 2)}`).join("\n\n") || "未执行"}`;
    }),
    "## 管理员后续操作\n\n可补充要求启动下一版增量协商，或在审阅证据并满意后手动终止。失败与未执行结果会保留，报告收齐不代表自动验收。",
  ].join("\n\n");
  await db.update(lifecycleRevisions).set({ report, updatedAt: new Date() }).where(eq(lifecycleRevisions.id, revision.id));
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
    await db.update(collaborationLifecycles).set({ phase: "executing", approvedHash: input.documentHash, approvedById: userId, approvedAt: new Date(), updatedAt: new Date() })
      .where(eq(collaborationLifecycles.collaborationId, collaborationId));
    await db.update(collaborations).set({ status: "in_progress", updatedAt: new Date() }).where(eq(collaborations.id, collaborationId));
    await notify(collaborationId, `管理员已确认第 ${control.revision} 版开发文档（${input.documentHash}）。双方可按此版实施并分别提交完整实际报告。`);
    await audit({ collaborationId, actorType: "user", actorId: userId, action: "lifecycle.approved", metadata: input });
    await queueWorkflowWakeup(collaborationId);
    return (await getLifecycleContext(collaborationId))!;
  });
}

export async function appendLifecycleRequirements(userId: string, collaborationId: string, input: { requirements: string }): Promise<LifecycleContext> {
  const requirements = input.requirements.trim();
  if (!requirements || requirements.length > 50_000) throw new HttpError(422, "追加要求不能为空且不得超过 50000 字符");
  return locked(collaborationId, async (control) => {
    await requireAdministrator(userId, collaborationId);
    if (!control || !["awaiting_review", "awaiting_approval"].includes(control.phase)) throw new HttpError(409, "请在完整报告收齐或开发文档待确认时追加要求；当前执行阶段不能切换修订");
    const previous = await getRevision(control);
    const revision = control.revision + 1;
    await requiredProjects(control);
    await db.insert(lifecycleRevisions).values({ id: newId(), collaborationId, revision,
      requirements: `${previous.requirements}\n\n## 第 ${revision} 版追加要求\n\n${requirements}`, changeRequest: requirements, createdById: userId,
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

export async function terminateLifecycle(userId: string, collaborationId: string, input: { revision?: number } = {}): Promise<LifecycleContext> {
  return locked(collaborationId, async (control) => {
    await requireAdministrator(userId, collaborationId);
    if (!control || (input.revision !== undefined && control.revision !== input.revision) || control.phase !== "awaiting_review") throw new HttpError(409, "仅能在当前完整实施报告收齐后由管理员手动终止协作");
    await db.update(collaborationLifecycles).set({ phase: "terminated", terminatedById: userId, terminatedAt: new Date(), updatedAt: new Date() })
      .where(eq(collaborationLifecycles.collaborationId, collaborationId));
    await db.update(connectorJobs).set({ status: "cancelled", error: "管理员已终止协作", leaseUntil: null, updatedAt: new Date() }).where(and(
      eq(connectorJobs.collaborationId, collaborationId), eq(connectorJobs.kind, "collaboration.turn"), inArray(connectorJobs.status, ["pending", "running"]),
    ));
    await db.update(collaborations).set({ status: "completed", updatedAt: new Date() }).where(eq(collaborations.id, collaborationId));
    await notify(collaborationId, `管理员已审阅第 ${control.revision} 版实施报告并手动终止协作。后续自动派发与旧任务回传均停止。`);
    await audit({ collaborationId, actorType: "user", actorId: userId, action: "lifecycle.terminated", metadata: { revision: control.revision } });
    return (await getLifecycleContext(collaborationId))!;
  });
}

export async function pauseLifecycle(userId: string, collaborationId: string, paused: boolean): Promise<LifecycleContext> {
  return locked(collaborationId, async (control) => {
    await requireAdministrator(userId, collaborationId);
    if (!control || control.phase === "terminated") throw new HttpError(409, "已终止或未开始的协作不能暂停或恢复");
    if (Boolean(control.pausedAt) === paused) return (await getLifecycleContext(collaborationId))!;
    await db.update(collaborationLifecycles).set({ pausedAt: paused ? new Date() : null, updatedAt: new Date() }).where(eq(collaborationLifecycles.collaborationId, collaborationId));
    if (paused) await db.update(connectorJobs).set({ status: "cancelled", error: "管理员暂停协作，等待执行端停止确认", leaseUntil: null, updatedAt: new Date() }).where(and(eq(connectorJobs.collaborationId, collaborationId), inArray(connectorJobs.status, ["pending", "running"])));
    else await queueWorkflowWakeup(collaborationId);
    await notify(collaborationId, paused ? "管理员已暂停协作，正在通知本机停止。已产生的文件修改不会自动撤销。" : "管理员已恢复协作，双方将核对现状后继续未完成阶段。");
    await audit({ collaborationId, actorType: "user", actorId: userId, action: paused ? "lifecycle.paused" : "lifecycle.resumed" });
    return (await getLifecycleContext(collaborationId))!;
  });
}
