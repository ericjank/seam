import { and, eq, inArray } from "drizzle-orm";
import { db, withTransaction } from "@/db";
import { collaborations, dependencies, participants, workItems } from "@/db/schema";
import { newId } from "@/lib/ids";
import { HttpError } from "@/lib/http";
import { authorizeActor, type Actor } from "./actor";
import { addSystemMessage } from "./collaborations";

export async function assertWorkItemDependencies(workItemId: string, collaborationId: string) {
  const deps = await db.select().from(dependencies).where(eq(dependencies.workItemId, workItemId));
  if (!deps.length) return;
  const predecessors = await db.select().from(workItems).where(and(
    eq(workItems.collaborationId, collaborationId), inArray(workItems.id, deps.map((dep) => dep.dependsOnId)),
  ));
  const blocking = predecessors.filter((predecessor) => predecessor.status !== "completed");
  if (blocking.length || predecessors.length !== deps.length) {
    const detail = blocking.map((predecessor) => `《${predecessor.title}》（${predecessor.status}）`).join("、");
    throw new HttpError(409, `前置任务未完成：${detail || "前置任务缺失"}。可并行的开发应拆为独立任务，部署与联调保留依赖。`);
  }
}

export async function createWorkItem(actor: Actor, collaborationId: string, input: {
  title: string;
  description?: string;
  assigneeParticipantId?: string;
  priority?: "low" | "normal" | "high" | "critical";
  acceptanceCriteria?: string;
  dependsOn?: string[];
}) {
  await authorizeActor(actor, collaborationId);
  return withTransaction(async () => {
    await db.select().from(collaborations).where(eq(collaborations.id, collaborationId)).limit(1).for("update");
    if (input.assigneeParticipantId) {
      const [assignee] = await db.select().from(participants).where(and(
        eq(participants.id, input.assigneeParticipantId), eq(participants.collaborationId, collaborationId), eq(participants.status, "active"),
      )).limit(1);
      if (!assignee) throw new HttpError(422, "任务负责人必须是本协作的有效参与方");
    }
    const dependsOn = [...new Set(input.dependsOn ?? [])];
    if (dependsOn.length > 50) throw new HttpError(422, "前置任务不能超过 50 个");
    if (dependsOn.length) {
      const existing = await db.select().from(workItems).where(and(
        eq(workItems.collaborationId, collaborationId), inArray(workItems.id, dependsOn),
      ));
      if (existing.length !== dependsOn.length) throw new HttpError(422, "前置任务不存在或不属于本协作");
    }
    const id = newId();
    await db.insert(workItems).values({
      id, collaborationId, title: input.title, description: input.description ?? "",
      assigneeParticipantId: input.assigneeParticipantId || null,
      priority: input.priority ?? "normal", acceptanceCriteria: input.acceptanceCriteria ?? "",
    });
    if (dependsOn.length) {
      await db.insert(dependencies).values(dependsOn.map((dependsOnId) => ({ id: newId(), workItemId: id, dependsOnId })));
    }
    await db.update(collaborations).set({ status: "in_progress", updatedAt: new Date() }).where(eq(collaborations.id, collaborationId));
    return { id };
  });
}

export async function updateWorkItem(actor: Actor, workItemId: string, input: {
  status?: "pending" | "in_progress" | "blocked" | "validating" | "completed" | "rejected";
  summary?: string;
}, expectedCollaborationId?: string) {
  const [existing] = await db.select().from(workItems).where(eq(workItems.id, workItemId)).limit(1);
  if (!existing || (expectedCollaborationId && existing.collaborationId !== expectedCollaborationId)) throw new HttpError(404, "任务不存在");
  await authorizeActor(actor, existing.collaborationId);
  return withTransaction(async () => {
    await db.select().from(collaborations).where(eq(collaborations.id, existing.collaborationId)).limit(1).for("update");
    const [item] = await db.select().from(workItems).where(eq(workItems.id, workItemId)).limit(1).for("update");
    if (!item || (expectedCollaborationId && item.collaborationId !== expectedCollaborationId)) throw new HttpError(404, "任务不存在");
    await authorizeActor(actor, item.collaborationId);
    const changed = !!input.status && input.status !== item.status;
    if (changed && input.status === "completed") {
      throw new HttpError(422, "请提交实际测试结果与验收证据后完成任务，状态更新不能代替验收");
    }
    if ((changed || input.status === "completed") && ["in_progress", "validating", "completed"].includes(input.status as string)) {
      await assertWorkItemDependencies(workItemId, item.collaborationId);
    }
    if (changed) await db.update(workItems).set({ status: input.status, updatedAt: new Date() }).where(eq(workItems.id, workItemId));
    if (input.summary) await addSystemMessage(item.collaborationId, `任务《${item.title}》：${input.summary}`);
    return { changed };
  });
}
