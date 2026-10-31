import { and, eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import { collaborations, dependencies, workItems } from "@/db/schema";
import { newId } from "@/lib/ids";
import { authorizeActor, type Actor } from "./actor";
import { addSystemMessage } from "./collaborations";

export async function createWorkItem(actor: Actor, collaborationId: string, input: {
  title: string;
  description?: string;
  assigneeParticipantId?: string;
  priority?: "low" | "normal" | "high" | "critical";
  acceptanceCriteria?: string;
  dependsOn?: string[];
}) {
  await authorizeActor(actor, collaborationId);
  const id = newId();
  await db.insert(workItems).values({
    id, collaborationId, title: input.title, description: input.description ?? "",
    assigneeParticipantId: input.assigneeParticipantId || null,
    priority: input.priority ?? "normal", acceptanceCriteria: input.acceptanceCriteria ?? "",
  });
  if (input.dependsOn?.length) {
    await db.insert(dependencies).values(input.dependsOn.map((dependsOnId) => ({ id: newId(), workItemId: id, dependsOnId })));
  }
  await db.update(collaborations).set({ status: "in_progress", updatedAt: new Date() }).where(eq(collaborations.id, collaborationId));
  return { id };
}

export async function updateWorkItem(actor: Actor, workItemId: string, input: {
  status?: "pending" | "in_progress" | "blocked" | "validating" | "completed" | "rejected";
  summary?: string;
}) {
  const [item] = await db.select().from(workItems).where(eq(workItems.id, workItemId)).limit(1);
  if (!item) throw new Error("任务不存在");
  await authorizeActor(actor, item.collaborationId);
  if (input.status === "in_progress") {
    const deps = await db.select().from(dependencies).where(eq(dependencies.workItemId, workItemId));
    if (deps.length) {
      const blocking = await db.select().from(workItems).where(and(inArray(workItems.id, deps.map((dep) => dep.dependsOnId)), inArray(workItems.status, ["pending", "in_progress", "blocked", "validating", "rejected"])));
      if (blocking.length) throw new Error(`仍有 ${blocking.length} 个前置任务未完成`);
    }
  }
  await db.update(workItems).set({ status: input.status ?? item.status, updatedAt: new Date() }).where(eq(workItems.id, workItemId));
  if (input.summary) await addSystemMessage(item.collaborationId, `任务《${item.title}》：${input.summary}`);
}
