import { and, eq, inArray } from "drizzle-orm";
import { db, withTransaction } from "@/db";
import { collaborations, connectorJobs, messages, participants } from "@/db/schema";
import { agentTurnResultSchema, informationTaskFor, lifecycleActions, type CollaborationContext, type Participant } from "@seam/protocol";
import { newId } from "@/lib/ids";
import { HttpError } from "@/lib/http";
import { normalizeLifecycleOutcome } from "@/lib/lifecycle-outcome";
import { nextWorkflowTargets, type Workflow } from "@/lib/workflow";
import { requireCollaborationAccess } from "@/lib/access";
import { getCollaborationDetail } from "./collaborations";
import { upsertArtifact } from "./artifacts";
import { createProposal, decideProposal } from "./proposals";
import { createWorkItem, updateWorkItem } from "./work-items";
import { requestCredential } from "./credentials";
import { submitAcceptance } from "./acceptance";
import { applyLifecycleAction, assertLifecycleJobCurrent, getLifecycleContext, type LifecycleSnapshot } from "./lifecycle";

export async function dispatchAgentTurns(userId: string, collaborationId: string, participantIds?: string[], options: { autoAdvance?: boolean } = {}) {
  await requireCollaborationAccess(userId, collaborationId, true);
  return withTransaction(async () => {
    const [collaboration] = await db.select().from(collaborations).where(eq(collaborations.id, collaborationId)).limit(1).for("update");
    if (!collaboration) throw new HttpError(404, "协作不存在");
    // Repeated clicks and messages join the current run. Polling refreshes its context.
    const active = await db.select().from(connectorJobs).where(and(
      eq(connectorJobs.collaborationId, collaborationId), eq(connectorJobs.kind, "collaboration.turn"),
      inArray(connectorJobs.status, ["pending", "running"]),
    ));
    if (active.length) return active.map((job) => job.id);
    const detail = await getCollaborationDetail(userId, collaborationId);
    if (detail.lifecycle) {
      if (detail.lifecycle.paused || !["planning", "plan_synthesis", "plan_confirmation", "executing", "joint_verifying"].includes(detail.lifecycle.phase)) throw new HttpError(409, "当前阶段等待管理员确认，不能继续派发实施");
      const eligible = lifecycleTargets(detail.lifecycle);
      participantIds = participantIds ? participantIds.filter((id) => eligible.includes(id)) : eligible;
    }
    const workflow: Workflow = {
      id: newId(), round: 1, maxRounds: Math.max(1, Math.min(collaboration.maxNegotiationRounds, 12)),
      autoAdvance: options.autoAdvance ?? false, inputMessageId: detail.messages.filter((m) => m.authorType === "user" && (m.metadata as Record<string, unknown>).dispatch !== false).at(-1)?.id,
    };
    return enqueueTurns(detail, workflow, participantIds);
  });
}

async function enqueueTurns(detail: Awaited<ReturnType<typeof getCollaborationDetail>>, workflow: Workflow, participantIds?: string[]) {
  const targets = detail.participants.filter((row) => row.participant.status === "active" && row.participant.agentId &&
    (!participantIds || participantIds.includes(row.participant.id)));
  if (!targets.length) throw new HttpError(409, "没有可派发的项目 Agent，请先绑定 Agent 并接受项目邀请");
  const jobs = [];
  for (const row of targets) {
    const id = newId();
    const context = buildContext(detail, row.participant.id, id);
    await db.insert(connectorJobs).values({
      id, agentId: row.participant.agentId as string, collaborationId: detail.collaboration.id,
      kind: "collaboration.turn", payload: { context, workflow, lifecycleSnapshot: detail.lifecycle ? {
        revision: detail.lifecycle.revision, phase: detail.lifecycle.phase,
        documentHash: detail.lifecycle.documentHash, approvedHash: detail.lifecycle.approvedHash,
      } : null },
    });
    jobs.push(id);
  }
  await db.update(collaborations).set({ negotiationRound: detail.collaboration.negotiationRound + 1, updatedAt: new Date() })
    .where(eq(collaborations.id, detail.collaboration.id));
  await db.insert(messages).values({
    id: newId(), collaborationId: detail.collaboration.id, authorType: "system", authorName: "Seam", kind: "system",
    body: `已向 ${jobs.length} 个项目 Agent 派发本次第 ${workflow.round}/${workflow.maxRounds} 批协作。`,
  });
  return jobs;
}

export function buildContext(detail: Awaited<ReturnType<typeof getCollaborationDetail>>, participantId: string, jobId?: string): CollaborationContext {
  const participantRows: Participant[] = detail.participants.map((row) => ({
    id: row.participant.id, projectId: row.participant.projectId, projectName: row.project.name,
    agentId: row.participant.agentId, agentName: row.agent?.name ?? null,
    role: row.participant.role, approvalRequired: row.participant.approvalRequired, status: row.participant.status,
  }));
  const participant = participantRows.find((row) => row.id === participantId);
  if (!participant) throw new HttpError(404, "参与方不存在");
  const mapMessage = (message: (typeof detail.messages)[number]) => ({
    id: message.id, participantId: message.participantId, authorType: message.authorType, authorName: message.authorName,
    kind: message.kind, body: message.body, metadata: message.metadata as Record<string, unknown>, createdAt: message.createdAt.toISOString(),
  });
  const referencedVersions = new Set(detail.proposals.map((p) => p.artifactVersionId));
  return {
    lifecycle: detail.lifecycle,
    informationTask: detail.lifecycle ? informationTaskFor(detail.lifecycle, participantId) : null,
    jobId, collaborationId: detail.collaboration.id, title: detail.collaboration.title,
    type: detail.collaboration.type, status: detail.collaboration.status, objective: detail.collaboration.objective,
    participant, participants: participantRows,
    messages: detail.messages.slice(-30).map(mapMessage),
    instructions: detail.messages.filter((message) => message.authorType === "user").map(mapMessage),
    artifacts: detail.artifacts.map((artifact) => ({
      id: artifact.id, title: artifact.title, type: artifact.type, currentVersion: artifact.currentVersion,
      versions: artifact.versions.filter((v) => v.version >= artifact.currentVersion - 1 || referencedVersions.has(v.id)).map((version) => ({
        id: version.id, artifactId: version.artifactId, version: version.version, content: version.content,
        contentHash: version.contentHash, createdByParticipantId: version.createdByParticipantId, createdAt: version.createdAt.toISOString(),
      })),
    })),
    workItems: detail.workItems.map((item) => ({
      id: item.id, title: item.title, description: item.description, assigneeParticipantId: item.assigneeParticipantId,
      status: item.status, priority: item.priority, acceptanceCriteria: item.acceptanceCriteria, dependsOn: item.dependsOn,
    })),
    proposals: detail.proposals.map((p) => ({
      id: p.id, title: p.title, body: p.body, status: p.status, artifactVersionId: p.artifactVersionId, approvalMode: p.approvalMode,
      approvals: p.approvals.map((a) => ({ participantId: a.participantId, decision: a.decision, comment: a.comment })),
    })),
    credentialRequests: detail.credentials.map((c) => ({ ...c, expiresAt: c.expiresAt?.toISOString() ?? null })),
    acceptanceRuns: detail.acceptanceRuns.map((a) => ({
      id: a.id, workItemId: a.workItemId, participantId: a.participantId, artifactVersionId: a.artifactVersionId,
      status: a.status, summary: a.summary, evidence: a.evidence as Record<string, unknown>, createdAt: a.createdAt.toISOString(),
    })),
  };
}

// Refresh at claim time, rather than making a queued agent act on an obsolete snapshot.
export async function refreshAgentJobContext(job: { id: string; kind: string; agentId: string; collaborationId: string | null; payload: unknown }) {
  if (job.kind !== "collaboration.turn" || !job.collaborationId) return job.payload;
  await assertLifecycleJobCurrent(job.collaborationId, (job.payload as { lifecycleSnapshot?: LifecycleSnapshot }).lifecycleSnapshot);
  const [collaboration] = await db.select().from(collaborations).where(eq(collaborations.id, job.collaborationId)).limit(1);
  const [participant] = await db.select().from(participants).where(and(eq(participants.agentId, job.agentId), eq(participants.collaborationId, job.collaborationId))).limit(1);
  if (!collaboration || participant?.status !== "active") throw new HttpError(409, "协作或有效参与方已不存在");
  const detail = await getCollaborationDetail(collaboration.createdById, collaboration.id);
  return { ...(job.payload as Record<string, unknown>), context: buildContext(detail, participant.id, job.id) };
}

export async function completeAgentTurn(jobId: string, result: unknown) {
  const [job] = await db.select().from(connectorJobs).where(eq(connectorJobs.id, jobId)).limit(1);
  if (!job?.collaborationId || job.kind !== "collaboration.turn") return;
  const [participant] = await db.select().from(participants)
    .where(and(eq(participants.agentId, job.agentId), eq(participants.collaborationId, job.collaborationId))).limit(1);
  if (!participant) throw new HttpError(409, "找不到返回结果对应的参与方");
  let turn = agentTurnResultSchema.parse((result as { agentTurn: unknown })?.agentTurn);
  const [collaboration] = await db.select().from(collaborations).where(eq(collaborations.id, job.collaborationId)).limit(1);
  if (!collaboration) throw new HttpError(404, "协作不存在");
  const detail = await getCollaborationDetail(collaboration.createdById, collaboration.id);
  const lifecycle = await assertLifecycleJobCurrent(collaboration.id, (job.payload as { lifecycleSnapshot?: LifecycleSnapshot }).lifecycleSnapshot);
  if (lifecycle) {
    const informationTask = (job.payload as { context?: CollaborationContext }).context?.informationTask;
    if (!informationTask) turn = normalizeLifecycleOutcome(turn, lifecycle.revision);
    const allowed = lifecycleActions(lifecycle.phase, Boolean(informationTask));
    if (turn.actions.some((action) => !allowed.includes(action.type))) throw new HttpError(409, "动作不符合当前生命周期阶段");
    if (informationTask && turn.actions.some(action => action.type !== "information.respond" || action.requestId !== informationTask.requestId)) throw new HttpError(409, "只读信息任务只能答复本次分配的问题");
    if (turn.actions.filter((action) => ["plan.submit", "plan.compose", "plan.confirm", "plan.reject", "execution.report", "integration.report", "workflow.blocked", "information.request", "information.respond"].includes(action.type)).length !== 1) throw new HttpError(422, "每轮必须提交一项当前阶段成果或明确阻塞");
  }
  // Validate the entire batch before applying any action. An Agent can participate in
  // multiple collaborations, but IDs from one run must never affect another.
  for (const action of turn.actions) {
    if ("artifactId" in action && action.artifactId && !detail.artifacts.some((a) => a.id === action.artifactId)) throw new HttpError(422, "产物不属于当前协作");
    if ("workItemId" in action && action.workItemId && !detail.workItems.some((w) => w.id === action.workItemId)) throw new HttpError(422, "任务不属于当前协作");
    if (action.type === "proposal.decide" && !detail.proposals.some((p) => p.id === action.proposalId)) throw new HttpError(422, "提案不属于当前协作");
    if (action.type === "credential.request" && !detail.participants.some((p) => p.participant.id === action.ownerParticipantId && p.participant.status === "active")) throw new HttpError(422, "凭据提供方不是当前协作的有效参与方");
  }
  const actor = { kind: "participant" as const, id: participant.id };
  let changed = false;
  for (const action of turn.actions) {
    if (action.type === "plan.submit" || action.type === "plan.compose" || action.type === "plan.reject" || action.type === "plan.confirm" || action.type === "execution.report" || action.type === "integration.report" || action.type === "workflow.blocked" || action.type === "service.publish" || action.type === "information.request" || action.type === "information.respond") {
      if (!lifecycle) throw new HttpError(409, "当前协作尚未启用管理员审批流程");
      const outcome = await applyLifecycleAction(actor, job.collaborationId, action);
      changed ||= outcome.changed;
    } else if (action.type === "artifact.upsert") {
      const outcome = await upsertArtifact(actor, job.collaborationId, { artifactId: action.artifactId, title: action.title, type: action.artifactType, content: action.content });
      changed ||= !outcome.unchanged;
    } else if (action.type === "proposal.create") {
      const artifact = detail.artifacts.find((a) => a.id === action.artifactId);
      const versionId = artifact?.versions.find((v) => v.version === artifact.currentVersion)?.id ?? null;
      if (!changed && detail.proposals.some((p) => ["open", "accepted"].includes(p.status) && p.title === action.title && p.body === action.body && p.artifactVersionId === versionId && p.approvalMode === action.approvalMode)) continue;
      await createProposal(actor, job.collaborationId, action); changed = true;
    } else if (action.type === "proposal.decide") {
      const proposal = detail.proposals.find((p) => p.id === action.proposalId);
      if (!changed && proposal?.approvals.some((a) => a.participantId === participant.id && a.decision === action.decision && a.comment === action.comment)) continue;
      await decideProposal(actor, action.proposalId, action.decision, action.comment); changed = true;
    } else if (action.type === "work.create") {
      if (detail.workItems.some((w) => w.title === action.title && w.description === action.description &&
        w.assigneeParticipantId === (action.assigneeParticipantId ?? null) && w.priority === action.priority &&
        w.acceptanceCriteria === action.acceptanceCriteria && [...w.dependsOn].sort().join() === [...action.dependsOn].sort().join())) continue;
      await createWorkItem(actor, job.collaborationId, action); changed = true;
    } else if (action.type === "work.update") {
      const outcome = await updateWorkItem(actor, action.workItemId, action, job.collaborationId);
      // Status commentary alone must not trigger an endless exchange.
      changed ||= outcome.changed;
    } else if (action.type === "credential.request") {
      if (detail.credentials.some((c) => c.ownerParticipantId === action.ownerParticipantId && c.recipientParticipantId === participant.id &&
        c.name === action.name && c.type === action.credentialType && c.environment === action.environment && c.purpose === action.purpose &&
        (!action.expiresAt || c.expiresAt?.toISOString() === action.expiresAt) &&
        ["requested", "offered", "approved", "granted"].includes(c.status) && (!c.expiresAt || c.expiresAt > new Date()))) continue;
      await requestCredential(actor, job.collaborationId, { ...action, type: action.credentialType, expiresAt: action.expiresAt ? new Date(action.expiresAt) : undefined }); changed = true;
    } else if (action.type === "acceptance.submit") {
      await submitAcceptance(actor, job.collaborationId, action); changed = true;
    }
  }
  await db.insert(messages).values({
    id: newId(), collaborationId: job.collaborationId, participantId: participant.id,
    authorType: "agent", authorName: detail.participants.find((row) => row.participant.id === participant.id)?.agent?.name ?? participant.id, kind: turn.kind, body: turn.message,
    metadata: { jobId, needsHumanInput: turn.needsHumanInput, actionCount: turn.actions.length, workflowChanged: changed },
  });
  await db.update(collaborations).set({ updatedAt: new Date() }).where(eq(collaborations.id, job.collaborationId));
}

export async function advanceAgentWorkflow(jobId: string) {
  const [job] = await db.select().from(connectorJobs).where(eq(connectorJobs.id, jobId)).limit(1);
  const workflow = (job?.payload as { workflow?: Workflow } | undefined)?.workflow;
  if (!job?.collaborationId || !workflow) return;
  return withTransaction(async () => {
    const [collaboration] = await db.select().from(collaborations).where(eq(collaborations.id, job.collaborationId!)).limit(1).for("update");
    if (!collaboration) return;
    const allJobs = await db.select().from(connectorJobs).where(and(eq(connectorJobs.collaborationId, collaboration.id), eq(connectorJobs.kind, "collaboration.turn")));
    const runJobs = allJobs.filter((j) => (j.payload as { workflow?: Workflow }).workflow?.id === workflow.id);
    if (runJobs.some((j) => (j.payload as { workflow: Workflow }).workflow.round > workflow.round)) return;
    const batch = runJobs.filter((j) => (j.payload as { workflow: Workflow }).workflow.round === workflow.round);
    if (batch.some((j) => j.status === "running" || j.status === "pending")) return;
    // A newer explicit run supersedes a late callback from an older one.
    if (allJobs.some((j) => j.status === "pending" || j.status === "running")) return;
    const detail = await getCollaborationDetail(collaboration.createdById, collaboration.id);
    if (detail.messages.some((m) => (m.metadata as Record<string, unknown>).workflowStopped === workflow.id)) return;
    if (detail.lifecycle) {
      if (allJobs.some((j) => j.sequence > job.sequence && (j.payload as { workflow?: Workflow }).workflow?.id !== workflow.id)) return;
      const snapshot = (job.payload as { lifecycleSnapshot?: LifecycleSnapshot }).lifecycleSnapshot;
      if (!snapshot || snapshot.revision !== detail.lifecycle.revision) return;
      const transitions: Record<string, string[]> = { planning: ["planning", "plan_synthesis"], plan_synthesis: ["plan_confirmation"], plan_confirmation: ["plan_confirmation", "plan_synthesis"], executing: ["executing", "joint_verifying"], joint_verifying: ["joint_verifying"] };
      if (!transitions[snapshot.phase]?.includes(detail.lifecycle.phase)) return;
      // Managed tasks advance by explicit phase receipts, never by the legacy
      // message heuristic. Both approval and final closure remain human gates.
      if (detail.lifecycle.paused || ["awaiting_approval", "awaiting_review", "terminated"].includes(detail.lifecycle.phase)) return;
      const targets = lifecycleTargets(detail.lifecycle);
      const informationProgress = batch.some(row => row.status === "completed" && (row.result as { agentTurn?: { actions?: Array<{ type: string }> } } | null)?.agentTurn?.actions?.some(action => action.type === "information.respond"));
      if (targets.length && (workflow.round < workflow.maxRounds || informationProgress)) {
        await enqueueTurns(detail, { ...workflow, id: informationProgress ? newId() : workflow.id, round: informationProgress ? 1 : workflow.round + 1 }, targets);
      } else if (targets.length) {
        await db.insert(messages).values({ id: newId(), collaborationId: collaboration.id, authorType: "system", authorName: "Seam", kind: "system", body: "自动协作连续重试已达上限，请查看失败原因后重试。", metadata: { workflowStopped: workflow.id } });
      }
      return;
    }
    if (detail.messages.some((m) => (m.metadata as Record<string, unknown>).workflowStopped === workflow.id)) return;
    const lastInputId = detail.messages.filter((m) => m.authorType === "user" && (m.metadata as Record<string, unknown>).dispatch !== false).at(-1)?.id;
    const outcome = nextWorkflowTargets({
      workflow, failed: batch.some((j) => j.status !== "completed"), completed: collaboration.status === "completed",
      activeParticipantIds: detail.participants.filter((p) => p.participant.status === "active" && p.participant.agentId).map((p) => p.participant.id),
      newInstruction: lastInputId !== workflow.inputMessageId,
      turns: batch.flatMap((j) => {
        const parsed = agentTurnResultSchema.safeParse((j.result as { agentTurn?: unknown } | null)?.agentTurn);
        const participant = detail.participants.find((p) => p.participant.agentId === j.agentId);
        const message = detail.messages.find((m) => (m.metadata as Record<string, unknown>).jobId === j.id);
        return parsed.success && participant ? [{ participantId: participant.participant.id, turn: parsed.data, changed: (message?.metadata as Record<string, unknown> | undefined)?.workflowChanged === true }] : [];
      }),
    });
    if (outcome.targets.length) {
      const newInstruction = lastInputId !== workflow.inputMessageId;
      if (newInstruction) {
        await db.insert(messages).values({
          id: newId(), collaborationId: collaboration.id, authorType: "system", authorName: "Seam", kind: "system",
          body: "已收到执行期间补充的新指令，开始新的有界推进。", metadata: { workflowStopped: workflow.id },
        });
      }
      await enqueueTurns(detail, {
        ...workflow, id: newInstruction ? newId() : workflow.id, round: newInstruction ? 1 : workflow.round + 1,
        autoAdvance: newInstruction ? true : workflow.autoAdvance, inputMessageId: lastInputId,
      }, outcome.targets);
    } else {
      // Idempotent stop marker, also visible to people through the normal event stream.
      if (detail.messages.some((m) => (m.metadata as Record<string, unknown>).workflowStopped === workflow.id)) return;
      await db.insert(messages).values({
        id: newId(), collaborationId: collaboration.id, authorType: "system", authorName: "Seam", kind: "system",
        body: outcome.reason!, metadata: { workflowStopped: workflow.id },
      });
      await db.update(collaborations).set({ updatedAt: new Date() }).where(eq(collaborations.id, collaboration.id));
    }
  });
}

function lifecycleTargets(lifecycle: NonNullable<Awaited<ReturnType<typeof getLifecycleContext>>>) {
  if (lifecycle.paused) return [];
  const informationTargets = lifecycle.requiredParticipantIds.filter(id => informationTaskFor(lifecycle, id));
  if (informationTargets.length) return informationTargets;
  if (lifecycle.blocks?.some((block) => block.kind === "needs_admin")) return [];
  const eligible = lifecycle.phase === "plan_synthesis" ? [lifecycle.coordinatorParticipantId ?? lifecycle.requiredParticipantIds[0]!] : lifecycle.requiredParticipantIds.filter((id) => lifecycle.phase === "planning"
    ? !lifecycle.contributions.some((entry) => entry.participantId === id)
    : lifecycle.phase === "plan_confirmation" ? !lifecycle.confirmations.includes(id)
    : lifecycle.phase === "executing" ? !lifecycle.reports.some((entry) => entry.participantId === id)
    : lifecycle.phase === "joint_verifying" ? !lifecycle.integrationReports.some((entry) => entry.participantId === id) : false);
  return eligible.filter((id) => {
    const block = lifecycle.blocks?.find((item) => item.participantId === id);
    if (!block) return true;
    if (block.kind === "gathering_info") return false;
    if (block.kind === "waiting_peer" && block.dependencyParticipantIds.length) return block.dependencyParticipantIds.every((dependency) => lifecycle.phase === "planning"
      ? lifecycle.contributions.some((item) => item.participantId === dependency)
      : lifecycle.services?.some((item) => item.participantId === dependency && Date.parse(item.expiresAt) > Date.now()));
    return block.retryAt !== null && Date.parse(block.retryAt) <= Date.now();
  });
}
