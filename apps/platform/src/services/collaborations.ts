import { and, asc, desc, eq, inArray } from "drizzle-orm";
import { adapterTelemetrySchema } from "@seam/protocol";
import { db } from "@/db";
import {
  acceptanceRuns,
  agents,
  approvals,
  artifactVersions,
  artifacts,
  auditEvents,
  collaborations,
  lifecycleRevisions,
  connectorJobs,
  credentials,
  dependencies,
  messages,
  participants,
  projects,
  proposals,
  users,
  workItems,
} from "@/db/schema";
import { newId } from "@/lib/ids";
import { requireCollaborationAccess, requireParticipantAccess, requireProjectAccess } from "@/lib/access";
import { audit } from "@/lib/audit";
import { listProjects } from "./projects";
import { HttpError } from "@/lib/http";
import { getLifecycleContext } from "./lifecycle";

async function resolveProjectAgent(projectId: string, agentId?: string) {
  const candidates = await db.select({ id: agents.id }).from(agents).where(eq(agents.projectId, projectId));
  if (agentId && !candidates.some((agent) => agent.id === agentId)) throw new HttpError(422, "Agent 不属于所选项目");
  return agentId || (candidates.length === 1 ? candidates[0]!.id : null);
}

export async function listCollaborations(userId: string) {
  return db.select({ collaboration: collaborations, project: projects })
    .from(collaborations)
    .innerJoin(participants, eq(collaborations.id, participants.collaborationId))
    .innerJoin(projects, eq(participants.projectId, projects.id))
    .innerJoin(users, and(eq(projects.orgId, users.orgId), eq(users.id, userId)))
    .orderBy(desc(collaborations.updatedAt));
}

export async function createCollaboration(userId: string, input: {
  title: string;
  type: "api-integration" | "event-integration" | "data-contract" | "release-coordination" | "custom";
  objective: string;
  projectId: string;
  agentId?: string;
}) {
  await requireProjectAccess(userId, input.projectId, true);
  const agentId = await resolveProjectAgent(input.projectId, input.agentId);
  const collaborationId = newId();
  const participantId = newId();
  await db.transaction(async (tx) => {
    await tx.insert(collaborations).values({
      id: collaborationId,
      title: input.title,
      type: input.type,
      objective: input.objective,
      createdById: userId,
      status: "draft",
    });
    await tx.insert(participants).values({
      id: participantId,
      collaborationId,
      projectId: input.projectId,
      agentId,
      role: "coordinator",
      status: "active",
    });
    await tx.insert(messages).values({
      id: newId(),
      collaborationId,
      authorType: "system",
      authorName: "Seam",
      kind: "system",
      body: "协作已创建，等待邀请其他项目参与。",
    });
  });
  await audit({ collaborationId, actorType: "user", actorId: userId, action: "collaboration.created" });
  return { id: collaborationId, participantId };
}

export async function inviteParticipant(userId: string, input: {
  collaborationId: string;
  projectId: string;
  agentId?: string;
  role: "provider" | "consumer" | "reviewer" | "participant";
}) {
  await requireCollaborationAccess(userId, input.collaborationId, true);
  const agentId = await resolveProjectAgent(input.projectId, input.agentId);
  const participant = {
    id: newId(),
    collaborationId: input.collaborationId,
    projectId: input.projectId,
    agentId,
    role: input.role,
    status: "invited" as const,
  };
  await db.insert(participants).values(participant);
  await addSystemMessage(input.collaborationId, "已向一个项目发出协作邀请，等待其项目成员确认。");
  return participant;
}

export async function acceptParticipant(userId: string, participantId: string) {
  const { participant } = await requireParticipantAccess(userId, participantId);
  await db.update(participants).set({ status: "active" }).where(eq(participants.id, participant.id));
  await addSystemMessage(participant.collaborationId, "一个项目已接受协作邀请。");
  await audit({ collaborationId: participant.collaborationId, actorType: "user", actorId: userId, action: "participant.accepted", metadata: { participantId } });
}

export async function addSystemMessage(collaborationId: string, body: string) {
  await db.insert(messages).values({
    id: newId(), collaborationId, authorType: "system", authorName: "Seam", kind: "system", body,
  });
  await db.update(collaborations).set({ updatedAt: new Date() }).where(eq(collaborations.id, collaborationId));
}

export async function addUserMessage(userId: string, collaborationId: string, body: string, dispatch = true) {
  const { collaboration } = await requireCollaborationAccess(userId, collaborationId, true);
  if (await getLifecycleContext(collaborationId)) throw new HttpError(409, "自动对接任务请通过补充要求创建新一轮文档，当前批准内容不能通过聊天改写");
  const [user] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
  const id = newId();
  await db.insert(messages).values({
    id, collaborationId, authorType: "user", authorName: user?.name ?? "用户", kind: "chat", body, metadata: { dispatch },
  });
  await db.update(collaborations).set({ updatedAt: new Date() }).where(eq(collaborations.id, collaboration.id));
  return id;
}

export async function getCollaborationDetail(userId: string, collaborationId: string) {
  const { collaboration, role } = await requireCollaborationAccess(userId, collaborationId);
  const participantRows = await db.select({ participant: participants, project: projects, agent: agents })
    .from(participants)
    .innerJoin(projects, eq(participants.projectId, projects.id))
    .leftJoin(agents, eq(participants.agentId, agents.id))
    .where(eq(participants.collaborationId, collaborationId))
    .orderBy(asc(participants.createdAt));
  const messageRows = await db.select().from(messages)
    .where(eq(messages.collaborationId, collaborationId)).orderBy(asc(messages.sequence));
  const artifactRows = await db.select().from(artifacts)
    .where(eq(artifacts.collaborationId, collaborationId)).orderBy(asc(artifacts.createdAt));
  const versionRows = artifactRows.length ? await db.select().from(artifactVersions)
    .where(inArray(artifactVersions.artifactId, artifactRows.map((item) => item.id)))
    .orderBy(asc(artifactVersions.version)) : [];
  const workRows = await db.select().from(workItems)
    .where(eq(workItems.collaborationId, collaborationId)).orderBy(asc(workItems.createdAt));
  const dependencyRows = workRows.length ? await db.select().from(dependencies)
    .where(inArray(dependencies.workItemId, workRows.map((item) => item.id))) : [];
  const proposalRows = await db.select().from(proposals)
    .where(eq(proposals.collaborationId, collaborationId)).orderBy(desc(proposals.createdAt));
  const approvalRows = proposalRows.length ? await db.select().from(approvals)
    .where(inArray(approvals.proposalId, proposalRows.map((item) => item.id))) : [];
  const credentialRows = await db.select({
    id: credentials.id, ownerParticipantId: credentials.ownerParticipantId,
    recipientParticipantId: credentials.recipientParticipantId, name: credentials.name,
    type: credentials.type, environment: credentials.environment, purpose: credentials.purpose,
    status: credentials.status, expiresAt: credentials.expiresAt, createdAt: credentials.createdAt,
  }).from(credentials).where(eq(credentials.collaborationId, collaborationId));
  const acceptanceRows = await db.select().from(acceptanceRuns)
    .where(eq(acceptanceRuns.collaborationId, collaborationId)).orderBy(desc(acceptanceRuns.sequence));
  const auditRows = await db.select().from(auditEvents)
    .where(eq(auditEvents.collaborationId, collaborationId)).orderBy(desc(auditEvents.sequence)).limit(100);
  const availableProjects = (await listProjects(userId)).map((row) => ({
    project: { id: row.project.id, name: row.project.name },
    agent: row.agent ? { id: row.agent.id, name: row.agent.name } : null,
  }));
  const jobRows = await db.select({
    id: connectorJobs.id, agentId: connectorJobs.agentId, kind: connectorJobs.kind,
    cancellationAckAt: connectorJobs.cancellationAckAt, leaseUntil: connectorJobs.leaseUntil, status: connectorJobs.status, error: connectorJobs.error, attempts: connectorJobs.attempts, updatedAt: connectorJobs.updatedAt, result: connectorJobs.result,
  }).from(connectorJobs).where(eq(connectorJobs.collaborationId, collaborationId)).orderBy(desc(connectorJobs.sequence)).limit(20);
  const agentIds = participantRows.flatMap((row) => row.agent ? [row.agent.id] : []);
  const capabilityRows = agentIds.length ? await db.select().from(auditEvents).where(and(
    eq(auditEvents.action, "connector.capabilities"), inArray(auditEvents.actorId, agentIds),
  )).orderBy(desc(auditEvents.sequence)) : [];

  return {
    collaboration,
    canAdminister: role === "owner",
    lifecycle: await getLifecycleContext(collaborationId),
    lifecycleHistory: await db.select({ revision: lifecycleRevisions.revision, requirements: lifecycleRevisions.requirements, document: lifecycleRevisions.document, documentHash: lifecycleRevisions.documentHash, report: lifecycleRevisions.report }).from(lifecycleRevisions).where(eq(lifecycleRevisions.collaborationId, collaborationId)).orderBy(desc(lifecycleRevisions.revision)),
    participants: participantRows,
    messages: messageRows,
    artifacts: artifactRows.map((artifact) => ({
      ...artifact,
      versions: versionRows.filter((version) => version.artifactId === artifact.id),
    })),
    workItems: workRows.map((item) => ({
      ...item,
      dependsOn: dependencyRows.filter((dep) => dep.workItemId === item.id).map((dep) => dep.dependsOnId),
    })),
    proposals: proposalRows.map((proposal) => ({
      ...proposal,
      approvals: approvalRows.filter((approval) => approval.proposalId === proposal.id),
    })),
    credentials: credentialRows,
    acceptanceRuns: acceptanceRows,
    auditEvents: auditRows,
    availableProjects,
    jobs: jobRows.map(({ result, ...job }) => {
      const record = result as { conversation?: { threadId?: unknown; transport?: unknown; title?: unknown; runLabel?: unknown }; telemetry?: unknown } | null;
      const conversation = record?.conversation, telemetry = adapterTelemetrySchema.safeParse(record?.telemetry);
      return { ...job, telemetry: telemetry.success ? telemetry.data : null, conversation: conversation?.transport === "codex-app-server" && typeof conversation.threadId === "string" && /^[0-9a-f-]{36}$/i.test(conversation.threadId)
        ? { threadId: conversation.threadId, transport: "codex-app-server" as const, title: typeof conversation.title === "string" ? conversation.title.slice(0, 200) : "本机 Codex 对话", runLabel: typeof conversation.runLabel === "string" ? conversation.runLabel.slice(0, 40) : "" } : null };
    }),
    connectorCapabilities: agentIds.flatMap((agentId) => {
      const report = capabilityRows.find((row) => row.actorId === agentId);
      if (!report) return [];
      const metadata = report.metadata as { adapter: string; executionMode: string; testConfigured: boolean; supportsInformationLookup?: boolean };
      return [{ agentId, ...metadata, reportedAt: report.createdAt.toISOString() }];
    }),
  };
}
