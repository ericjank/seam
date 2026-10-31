import { and, desc, eq } from "drizzle-orm";
import { db } from "@/db";
import { acceptanceRuns, artifactVersions, artifacts, collaborations, workItems } from "@/db/schema";
import { newId } from "@/lib/ids";
import { authorizeActor, type Actor } from "./actor";
import { addSystemMessage } from "./collaborations";
import { audit } from "@/lib/audit";

export async function submitAcceptance(actor: Actor, collaborationId: string, input: {
  workItemId?: string;
  artifactId?: string;
  status: "passed" | "failed";
  summary: string;
  evidence?: Record<string, unknown>;
}) {
  const participantId = await authorizeActor(actor, collaborationId);
  if (!participantId) throw new Error("测试证据必须由具体项目参与方提交");
  let artifactVersionId: string | null = null;
  if (input.artifactId) {
    const [artifact] = await db.select().from(artifacts).where(eq(artifacts.id, input.artifactId)).limit(1);
    if (!artifact || artifact.collaborationId !== collaborationId) throw new Error("验收产物不存在");
    const [version] = await db.select().from(artifactVersions)
      .where(and(eq(artifactVersions.artifactId, artifact.id), eq(artifactVersions.version, artifact.currentVersion))).limit(1);
    artifactVersionId = version?.id ?? null;
  }
  const id = newId();
  await db.insert(acceptanceRuns).values({
    id, collaborationId, workItemId: input.workItemId || null, participantId,
    artifactVersionId, status: input.status, summary: input.summary, evidence: input.evidence ?? {},
  });
  if (input.workItemId) {
    await db.update(workItems).set({ status: input.status === "passed" ? "completed" : "in_progress", updatedAt: new Date() })
      .where(eq(workItems.id, input.workItemId));
  }
  await db.update(collaborations).set({ status: "validating", updatedAt: new Date() }).where(eq(collaborations.id, collaborationId));
  await addSystemMessage(collaborationId, `收到验收结果：${input.status === "passed" ? "通过" : "未通过"}。${input.summary}`);
  await audit({ collaborationId, actorType: "agent", actorId: actor.id, action: `acceptance.${input.status}`, metadata: { acceptanceRunId: id, artifactVersionId } });
  await evaluateCollaboration(collaborationId);
  return { id };
}

async function evaluateCollaboration(collaborationId: string) {
  const items = await db.select().from(workItems).where(eq(workItems.collaborationId, collaborationId));
  if (items.length && items.every((item) => item.status === "completed")) {
    await db.update(collaborations).set({ status: "completed", updatedAt: new Date() }).where(eq(collaborations.id, collaborationId));
    await addSystemMessage(collaborationId, "全部任务已完成并通过验收，协作完成。");
  }
}

export async function listAcceptance(collaborationId: string) {
  return db.select().from(acceptanceRuns).where(eq(acceptanceRuns.collaborationId, collaborationId)).orderBy(desc(acceptanceRuns.createdAt));
}
