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

function contextFrom(control: Lifecycle, revision: Revision, contributions: Contribution[]): LifecycleContext {
  const relevant = contributions.filter((row) => control.requiredParticipantIds.includes(row.participantId));
  return {
    revision: control.revision, phase: control.phase, requirements: revision.requirements,
    document: revision.document, documentHash: control.documentHash, approvedHash: control.approvedHash,
    requiredParticipantIds: control.requiredParticipantIds,
    contributions: relevant.flatMap((row) => row.content ? [{ participantId: row.participantId, content: row.content }] : []),
    confirmations: relevant.filter((row) => control.documentHash && row.confirmedHash === control.documentHash).map((row) => row.participantId),
    reports: relevant.flatMap((row) => row.reportStatus && row.reportSummary ? [{
      participantId: row.participantId, status: row.reportStatus, summary: row.reportSummary, evidence: row.reportEvidence ?? {},
    }] : []),
    report: revision.report,
  };
}

export async function getLifecycleContext(collaborationId: string): Promise<LifecycleContext | null> {
  const control = await getControl(collaborationId);
  if (!control) return null;
  return contextFrom(control, await getRevision(control), await getContributions(control));
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
    const active = await db.select().from(participants).where(and(eq(participants.collaborationId, collaborationId), eq(participants.status, "active")));
    const requiredParticipantIds = active.map((participant) => participant.id);
    await requiredProjects({ collaborationId, requiredParticipantIds }, true);
    await db.insert(collaborationLifecycles).values({ collaborationId, requiredParticipantIds, revision: 1, phase: "planning" });
    await db.insert(lifecycleRevisions).values({ id: newId(), collaborationId, revision: 1, requirements: collaboration.objective, createdById: userId });
    await db.update(collaborations).set({ status: "negotiating", updatedAt: new Date() }).where(eq(collaborations.id, collaborationId));
    await notify(collaborationId, "目标已提交。双方 AI 将先协商共同开发文档；管理员确认指定版本和内容后才会执行开发。");
    await audit({ collaborationId, actorType: "user", actorId: userId, action: "lifecycle.started", metadata: { revision: 1, requiredParticipantIds } });
    return (await getLifecycleContext(collaborationId))!;
  });
}

export async function applyLifecycleAction(actor: Actor, collaborationId: string, rawAction: LifecycleAgentAction): Promise<{ changed: boolean }> {
  const action = lifecycleAgentActionSchema.parse(rawAction);
  return locked(collaborationId, async (control, collaboration) => {
    if (!control) throw new HttpError(409, "该协作尚未启用管理员确认开发流程");
    const participantId = await authorizeActor(actor, collaborationId);
    if (!participantId || actor.kind !== "participant" || !control.requiredParticipantIds.includes(participantId)) throw new HttpError(403, "仅本轮指定的项目 Agent 可提交计划、确认或实施报告");
    if (action.revision !== control.revision || control.phase === "terminated") throw new HttpError(409, "协作修订已失效或已终止");
    await requiredProjects(control);
    const revision = await getRevision(control);
    const existing = (await getContributions(control)).find((row) => row.participantId === participantId);
    if (action.type === "plan.submit") {
      if (!["planning", "plan_confirmation"].includes(control.phase)) throw new HttpError(409, "当前阶段不能修改开发文档；请由管理员追加要求后重新协商");
      if (existing?.content === action.content) return { changed: false };
      await db.insert(lifecycleContributions).values({ id: newId(), collaborationId, revision: control.revision, participantId, content: action.content })
        .onDuplicateKeyUpdate({ set: { content: action.content, updatedAt: new Date() } });
      const contributions = await getContributions(control);
      const allSubmitted = control.requiredParticipantIds.every((id) => contributions.some((row) => row.participantId === id && row.content));
      let document: string | null = null;
      let documentHash: string | null = null;
      if (allSubmitted) {
        const projectRows = await requiredProjects(control);
        document = [
          `# ${collaboration.title}：共同开发文档（第 ${control.revision} 版）`,
          `## 目标与本轮要求\n\n${revision.requirements}`,
          "## 共同执行边界\n\n双方须确认同一份完整文档及内容哈希。管理员确认后才允许实施；代码、实际测试、部署与业务验收分别报告，不得将模拟结果冒充实际完成。",
          ...projectRows.map((row) => `## ${row.project.name}（${row.participant.role}）\n\n${contributions.find((item) => item.participantId === row.participant.id)!.content}`),
        ].join("\n\n");
        documentHash = hash(document);
      }
      // Any plan edit invalidates all confirmations, even if both sides had already
      // agreed. Only a fresh confirmation of this exact assembled content can pass.
      await db.update(lifecycleContributions).set({ confirmedHash: null, updatedAt: new Date() }).where(currentContribution(collaborationId, control.revision));
      await db.update(lifecycleRevisions).set({ document, documentHash, updatedAt: new Date() }).where(eq(lifecycleRevisions.id, revision.id));
      await db.update(collaborationLifecycles).set({ phase: allSubmitted ? "plan_confirmation" : "planning", documentHash, approvedHash: null, approvedById: null, approvedAt: null, updatedAt: new Date() })
        .where(eq(collaborationLifecycles.collaborationId, collaborationId));
      await notify(collaborationId, allSubmitted ? `第 ${control.revision} 版共同开发文档已汇总，等待双方确认同一内容；尚未获得管理员执行授权。` : `已收到本轮一个项目的开发计划，等待另一方补齐。`);
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
    if (control.phase !== "executing" || !control.approvedHash || control.approvedHash !== control.documentHash) throw new HttpError(409, "当前开发文档尚未获管理员确认，不能提交实施报告");
    if (existing?.reportStatus === action.status && existing.reportSummary === action.summary && JSON.stringify(existing.reportEvidence) === JSON.stringify(action.evidence)) return { changed: false };
    await db.insert(lifecycleContributions).values({ id: newId(), collaborationId, revision: control.revision, participantId, reportStatus: action.status, reportSummary: action.summary, reportEvidence: action.evidence })
      .onDuplicateKeyUpdate({ set: { reportStatus: action.status, reportSummary: action.summary, reportEvidence: action.evidence, updatedAt: new Date() } });
    const contributions = await getContributions(control);
    if (control.requiredParticipantIds.every((id) => contributions.some((row) => row.participantId === id && row.reportStatus && row.reportSummary))) {
      const projectRows = await requiredProjects(control);
      const report = [
        `# ${collaboration.title}：完整实施报告（第 ${control.revision} 版）`,
        `开发文档哈希：\`${control.approvedHash}\``,
        ...projectRows.map((row) => {
          const result = contributions.find((item) => item.participantId === row.participant.id)!;
          return `## ${row.project.name}：${result.reportStatus === "passed" ? "报告通过" : "存在失败或阻塞"}\n\n${result.reportSummary}\n\n### 实际证据\n\n\`\`\`json\n${JSON.stringify(result.reportEvidence ?? {}, null, 2)}\n\`\`\``;
        }),
        "## 管理员后续操作\n\n请审阅双方实际结果。可追加要求进入下一版共同开发文档，也可在满意后手动终止本次协作。报告收齐不代表自动验收或自动终止。",
      ].join("\n\n");
      await db.update(lifecycleRevisions).set({ report, updatedAt: new Date() }).where(eq(lifecycleRevisions.id, revision.id));
      await db.update(collaborationLifecycles).set({ phase: "awaiting_review", updatedAt: new Date() }).where(eq(collaborationLifecycles.collaborationId, collaborationId));
      await db.update(collaborations).set({ status: "validating", updatedAt: new Date() }).where(eq(collaborations.id, collaborationId));
      await notify(collaborationId, `第 ${control.revision} 版双方实施报告已收齐。请管理员审阅后追加要求或手动终止；协作不会自行结束。`);
    }
    return { changed: true };
  });
}

export async function approveLifecycle(userId: string, collaborationId: string, input: { revision: number; documentHash: string }): Promise<LifecycleContext> {
  return locked(collaborationId, async (control) => {
    await requireAdministrator(userId, collaborationId);
    if (!control || control.revision !== input.revision || control.phase !== "awaiting_approval" || control.documentHash !== input.documentHash) throw new HttpError(409, "文档版本、内容或阶段已变化，请重新阅读当前完整文档再确认");
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
      requirements: `${previous.requirements}\n\n## 第 ${revision} 版追加要求\n\n${requirements}`, createdById: userId,
    });
    await db.update(collaborationLifecycles).set({ revision, phase: "planning", documentHash: null, approvedHash: null, approvedById: null, approvedAt: null, updatedAt: new Date() })
      .where(eq(collaborationLifecycles.collaborationId, collaborationId));
    await db.update(connectorJobs).set({ status: "cancelled", error: "管理员追加要求，旧修订任务已失效", leaseUntil: null, updatedAt: new Date() }).where(and(
      eq(connectorJobs.collaborationId, collaborationId), eq(connectorJobs.kind, "collaboration.turn"), inArray(connectorJobs.status, ["pending", "running"]),
    ));
    await db.update(collaborations).set({ status: "negotiating", updatedAt: new Date() }).where(eq(collaborations.id, collaborationId));
    await notify(collaborationId, `管理员已追加第 ${revision} 版要求。双方将重新协商完整开发文档，旧版执行授权不适用于新版。`);
    await audit({ collaborationId, actorType: "user", actorId: userId, action: "lifecycle.requirements_appended", metadata: { revision } });
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
