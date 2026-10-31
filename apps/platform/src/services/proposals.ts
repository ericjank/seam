import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { approvals, artifactVersions, artifacts, collaborations, participants, proposals } from "@/db/schema";
import { newId } from "@/lib/ids";
import { authorizeActor, type Actor } from "./actor";
import { addSystemMessage } from "./collaborations";
import { audit } from "@/lib/audit";

export async function createProposal(actor: Actor, collaborationId: string, input: {
  title: string;
  body: string;
  artifactId?: string;
  approvalMode?: "all" | "required";
}) {
  const participantId = await authorizeActor(actor, collaborationId);
  let artifactVersionId: string | null = null;
  if (input.artifactId) {
    const [artifact] = await db.select().from(artifacts).where(eq(artifacts.id, input.artifactId)).limit(1);
    if (!artifact || artifact.collaborationId !== collaborationId) throw new Error("产物不存在");
    const [version] = await db.select().from(artifactVersions)
      .where(and(eq(artifactVersions.artifactId, artifact.id), eq(artifactVersions.version, artifact.currentVersion))).limit(1);
    artifactVersionId = version?.id ?? null;
  }
  const id = newId();
  await db.insert(proposals).values({
    id, collaborationId, title: input.title, body: input.body, artifactVersionId,
    approvalMode: input.approvalMode ?? "required", createdByParticipantId: participantId,
  });
  await db.update(collaborations).set({ status: "negotiating", updatedAt: new Date() }).where(eq(collaborations.id, collaborationId));
  await addSystemMessage(collaborationId, `新提案《${input.title}》等待参与方确认。`);
  return { id, artifactVersionId };
}

export async function decideProposal(actor: Actor, proposalId: string, decision: "approved" | "rejected", comment = "") {
  const [proposal] = await db.select().from(proposals).where(eq(proposals.id, proposalId)).limit(1);
  if (!proposal || proposal.status !== "open") throw new Error("提案不存在或已关闭");
  const participantId = await authorizeActor(actor, proposal.collaborationId);
  if (!participantId) throw new Error("请选择代表哪个项目参与方进行确认");
  const [participant] = await db.select().from(participants).where(eq(participants.id, participantId)).limit(1);
  if (!participant || participant.status !== "active") throw new Error("参与方尚未接受邀请");
  await db.insert(approvals).values({
    id: newId(), proposalId, participantId, artifactVersionId: proposal.artifactVersionId, decision, comment,
  }).onDuplicateKeyUpdate({ set: { decision, comment, artifactVersionId: proposal.artifactVersionId, createdAt: new Date() } });
  await evaluateProposal(proposalId);
  await audit({ collaborationId: proposal.collaborationId, actorType: actor.kind === "user" ? "user" : "agent", actorId: actor.id, action: `proposal.${decision}`, metadata: { proposalId, participantId } });
}

async function evaluateProposal(proposalId: string) {
  const [proposal] = await db.select().from(proposals).where(eq(proposals.id, proposalId)).limit(1);
  if (!proposal) return;
  const participantRows = await db.select().from(participants)
    .where(and(eq(participants.collaborationId, proposal.collaborationId), eq(participants.status, "active")));
  const required = participantRows.filter((item) => proposal.approvalMode === "all" || item.approvalRequired);
  const approvalRows = await db.select().from(approvals).where(eq(approvals.proposalId, proposalId));
  if (approvalRows.some((item) => item.decision === "rejected")) {
    await db.update(proposals).set({ status: "rejected", updatedAt: new Date() }).where(eq(proposals.id, proposalId));
    await addSystemMessage(proposal.collaborationId, `提案《${proposal.title}》被否决，需要继续协商。`);
    return;
  }
  const accepted = required.length > 0 && required.every((participant) => approvalRows.some((item) =>
    item.participantId === participant.id && item.decision === "approved" && item.artifactVersionId === proposal.artifactVersionId));
  if (accepted) {
    await db.update(proposals).set({ status: "accepted", updatedAt: new Date() }).where(eq(proposals.id, proposalId));
    await db.update(collaborations).set({ status: "accepted", updatedAt: new Date() }).where(eq(collaborations.id, proposal.collaborationId));
    await addSystemMessage(proposal.collaborationId, `提案《${proposal.title}》已由全部必要参与方确认，可以开始实施。`);
  }
}
