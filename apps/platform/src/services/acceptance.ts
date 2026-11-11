import { and, desc, eq } from "drizzle-orm";
import { db, withTransaction } from "@/db";
import { acceptanceRuns, artifactVersions, artifacts, collaborations, workItems } from "@/db/schema";
import { newId } from "@/lib/ids";
import { authorizeActor, type Actor } from "./actor";
import { addSystemMessage } from "./collaborations";
import { audit } from "@/lib/audit";
import { HttpError } from "@/lib/http";
import { assertWorkItemDependencies } from "./work-items";
import { getLifecycleContext } from "./lifecycle";

export async function submitAcceptance(actor: Actor, collaborationId: string, input: {
  workItemId?: string;
  artifactId?: string;
  status: "passed" | "failed";
  summary: string;
  evidence?: Record<string, unknown>;
}) {
  const participantId = await authorizeActor(actor, collaborationId);
  if (!participantId) throw new HttpError(422, "测试证据必须由具体项目参与方提交");
  return withTransaction(async () => {
    await db.select().from(collaborations).where(eq(collaborations.id, collaborationId)).limit(1).for("update");
    if (input.workItemId) {
      const [item] = await db.select().from(workItems).where(and(
        eq(workItems.id, input.workItemId), eq(workItems.collaborationId, collaborationId),
      )).limit(1).for("update");
      if (!item) throw new HttpError(404, "验收任务不存在或不属于本协作");
      if (item.assigneeParticipantId && item.assigneeParticipantId !== participantId) {
        throw new HttpError(403, "只能提交本项目负责的任务验收");
      }
      if (input.status === "passed") {
        // Use the same dependency checks as an explicit task transition.
        await assertWorkItemDependencies(item.id, collaborationId);
        await db.update(workItems).set({ status: "completed", updatedAt: new Date() }).where(eq(workItems.id, item.id));
      } else if (["completed", "validating"].includes(item.status)) {
        await db.update(workItems).set({ status: "in_progress", updatedAt: new Date() }).where(eq(workItems.id, item.id));
      }
    }
    let artifactVersionId: string | null = null;
    if (input.artifactId) {
      const [artifact] = await db.select().from(artifacts).where(and(eq(artifacts.id, input.artifactId), eq(artifacts.collaborationId, collaborationId))).limit(1);
      if (!artifact) throw new HttpError(404, "验收产物不存在或不属于本协作");
      const [version] = await db.select().from(artifactVersions)
        .where(and(eq(artifactVersions.artifactId, artifact.id), eq(artifactVersions.version, artifact.currentVersion))).limit(1);
      if (!version) throw new HttpError(409, "验收产物的当前版本不存在");
      artifactVersionId = version.id;
    }
    const id = newId();
    await db.insert(acceptanceRuns).values({
      id, collaborationId, workItemId: input.workItemId || null, participantId,
      artifactVersionId, status: input.status, summary: input.summary, evidence: input.evidence ?? {},
    });
    await db.update(collaborations).set({ status: "validating", updatedAt: new Date() }).where(eq(collaborations.id, collaborationId));
    await addSystemMessage(collaborationId, `收到验收结果：${input.status === "passed" ? "通过" : "未通过"}。${input.summary}`);
    await audit({ collaborationId, actorType: "agent", actorId: actor.id, action: `acceptance.${input.status}`, metadata: { acceptanceRunId: id, artifactVersionId } });
    await evaluateCollaboration(collaborationId);
    return { id };
  });
}

async function evaluateCollaboration(collaborationId: string) {
  // Managed collaboration closure is exclusively an administrator decision.
  if (await getLifecycleContext(collaborationId)) return;
  const items = await db.select().from(workItems).where(eq(workItems.collaborationId, collaborationId));
  if (items.length && items.every((item) => item.status === "completed")) {
    const runs = await db.select().from(acceptanceRuns).where(eq(acceptanceRuns.collaborationId, collaborationId)).orderBy(desc(acceptanceRuns.sequence));
    const verified = items.every((item) => runs.find((run) => run.workItemId === item.id &&
      (!item.assigneeParticipantId || run.participantId === item.assigneeParticipantId))?.status === "passed");
    if (!verified) return;
    await db.update(collaborations).set({ status: "completed", updatedAt: new Date() }).where(eq(collaborations.id, collaborationId));
    await addSystemMessage(collaborationId, "全部任务已完成并通过验收，协作完成。");
  }
}

export async function listAcceptance(collaborationId: string) {
  return db.select().from(acceptanceRuns).where(eq(acceptanceRuns.collaborationId, collaborationId)).orderBy(desc(acceptanceRuns.sequence));
}
