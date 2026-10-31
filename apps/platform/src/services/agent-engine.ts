import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { agents, collaborations, connectorJobs, messages, participants } from "@/db/schema";
import { agentTurnResultSchema, type CollaborationContext, type Participant } from "@seam/protocol";
import { newId } from "@/lib/ids";
import { requireCollaborationAccess } from "@/lib/access";
import { getCollaborationDetail, addSystemMessage } from "./collaborations";
import { upsertArtifact } from "./artifacts";
import { createProposal, decideProposal } from "./proposals";
import { createWorkItem, updateWorkItem } from "./work-items";
import { requestCredential } from "./credentials";
import { submitAcceptance } from "./acceptance";

export async function dispatchAgentTurns(userId: string, collaborationId: string, participantIds?: string[]) {
  await requireCollaborationAccess(userId, collaborationId, true);
  const [collaboration] = await db.select().from(collaborations).where(eq(collaborations.id, collaborationId)).limit(1);
  if (!collaboration || collaboration.negotiationRound >= collaboration.maxNegotiationRounds) throw new Error("已达到最大协商轮次，需要人工检查");
  await db.update(collaborations).set({ negotiationRound: collaboration.negotiationRound + 1, updatedAt: new Date() }).where(eq(collaborations.id, collaborationId));
  return enqueueTurns(userId, collaborationId, participantIds);
}

async function enqueueTurns(userId: string, collaborationId: string, participantIds?: string[]) {
  const detail = await getCollaborationDetail(userId, collaborationId);
  const targets = detail.participants.filter((row) =>
    row.participant.status === "active" && row.participant.agentId && (!participantIds || participantIds.includes(row.participant.id)));
  const jobs = [];
  for (const row of targets) {
    const context = buildContext(detail, row.participant.id);
    const id = newId();
    await db.insert(connectorJobs).values({
      id, agentId: row.participant.agentId as string, collaborationId, kind: "collaboration.turn", payload: { context },
    });
    jobs.push(id);
  }
  if (jobs.length) await addSystemMessage(collaborationId, `已向 ${jobs.length} 个项目 Agent 派发第 ${detail.collaboration.negotiationRound + 1} 轮协作。`);
  return jobs;
}

function buildContext(detail: Awaited<ReturnType<typeof getCollaborationDetail>>, participantId: string): CollaborationContext {
  const participantRows: Participant[] = detail.participants.map((row) => ({
    id: row.participant.id,
    projectId: row.participant.projectId,
    projectName: row.project.name,
    agentId: row.participant.agentId,
    agentName: row.agent?.name ?? null,
    role: row.participant.role,
    approvalRequired: row.participant.approvalRequired,
    status: row.participant.status,
  }));
  const participant = participantRows.find((row) => row.id === participantId);
  if (!participant) throw new Error("参与方不存在");
  return {
    collaborationId: detail.collaboration.id,
    title: detail.collaboration.title,
    type: detail.collaboration.type,
    status: detail.collaboration.status,
    objective: detail.collaboration.objective,
    participant,
    participants: participantRows,
    messages: detail.messages.slice(-30).map((message) => ({
      id: message.id, participantId: message.participantId, authorType: message.authorType,
      authorName: message.authorName, kind: message.kind, body: message.body,
      metadata: message.metadata as Record<string, unknown>, createdAt: message.createdAt.toISOString(),
    })),
    artifacts: detail.artifacts.map((artifact) => ({
      id: artifact.id, title: artifact.title, type: artifact.type, currentVersion: artifact.currentVersion,
      versions: artifact.versions.map((version) => ({
        id: version.id, artifactId: version.artifactId, version: version.version, content: version.content,
        contentHash: version.contentHash, createdByParticipantId: version.createdByParticipantId,
        createdAt: version.createdAt.toISOString(),
      })),
    })),
    workItems: detail.workItems.map((item) => ({
      id: item.id, title: item.title, description: item.description, assigneeParticipantId: item.assigneeParticipantId,
      status: item.status, priority: item.priority, acceptanceCriteria: item.acceptanceCriteria, dependsOn: item.dependsOn,
    })),
  };
}

export async function completeAgentTurn(jobId: string, result: unknown) {
  const [job] = await db.select().from(connectorJobs).where(eq(connectorJobs.id, jobId)).limit(1);
  if (!job?.collaborationId || job.kind !== "collaboration.turn") return;
  const [participant] = await db.select().from(participants)
    .where(and(eq(participants.agentId, job.agentId), eq(participants.collaborationId, job.collaborationId))).limit(1);
  if (!participant) throw new Error("找不到返回结果对应的参与方");
  const turn = agentTurnResultSchema.parse((result as { agentTurn: unknown }).agentTurn);
  const actor = { kind: "participant" as const, id: participant.id };
  await db.insert(messages).values({
    id: newId(), collaborationId: job.collaborationId, participantId: participant.id,
    authorType: "agent", authorName: participant.id, kind: turn.kind, body: turn.message,
    metadata: { needsHumanInput: turn.needsHumanInput, actionCount: turn.actions.length },
  });
  for (const action of turn.actions) {
    if (action.type === "artifact.upsert") {
      await upsertArtifact(actor, job.collaborationId, { artifactId: action.artifactId, title: action.title, type: action.artifactType, content: action.content });
    } else if (action.type === "proposal.create") {
      await createProposal(actor, job.collaborationId, action);
    } else if (action.type === "proposal.decide") {
      await decideProposal(actor, action.proposalId, action.decision, action.comment);
    } else if (action.type === "work.create") {
      await createWorkItem(actor, job.collaborationId, action);
    } else if (action.type === "work.update") {
      await updateWorkItem(actor, action.workItemId, action);
    } else if (action.type === "credential.request") {
      await requestCredential(actor, job.collaborationId, {
        ...action, type: action.credentialType, expiresAt: action.expiresAt ? new Date(action.expiresAt) : undefined,
      });
    } else if (action.type === "acceptance.submit") {
      await submitAcceptance(actor, job.collaborationId, action);
    }
  }
  const [collaboration] = await db.select().from(collaborations).where(eq(collaborations.id, job.collaborationId)).limit(1);
  if (turn.notifyParticipantIds.length && collaboration && collaboration.negotiationRound < collaboration.maxNegotiationRounds) {
    await db.update(collaborations).set({ negotiationRound: collaboration.negotiationRound + 1, updatedAt: new Date() }).where(eq(collaborations.id, collaboration.id));
    await enqueueTurns(collaboration.createdById, collaboration.id, turn.notifyParticipantIds);
  }
}
