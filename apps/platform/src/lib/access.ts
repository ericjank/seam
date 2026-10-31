import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { collaborations, participants, projects, users } from "@/db/schema";
import { HttpError } from "./http";

export async function requireProjectAccess(userId: string, projectId: string, write = false) {
  const [row] = await db
    .select({ project: projects, role: users.role })
    .from(projects)
    .innerJoin(users, eq(projects.orgId, users.orgId))
    .where(and(eq(projects.id, projectId), eq(users.id, userId)))
    .limit(1);
  if (!row) throw new HttpError(404, "项目不存在或无权访问");
  if (write && row.role === "viewer") throw new HttpError(403, "只读成员不能修改项目");
  return row;
}

export async function requireCollaborationAccess(userId: string, collaborationId: string, write = false) {
  const [row] = await db
    .select({ collaboration: collaborations, role: users.role })
    .from(collaborations)
    .innerJoin(participants, eq(collaborations.id, participants.collaborationId))
    .innerJoin(projects, eq(participants.projectId, projects.id))
    .innerJoin(users, and(eq(projects.orgId, users.orgId), eq(users.id, userId)))
    .where(eq(collaborations.id, collaborationId))
    .limit(1);
  if (!row) throw new HttpError(404, "协作不存在或无权访问");
  if (write && row.role === "viewer") throw new HttpError(403, "只读成员不能修改协作");
  return row;
}

export async function requireParticipantAccess(userId: string, participantId: string) {
  const [row] = await db
    .select({ participant: participants, project: projects, role: users.role })
    .from(participants)
    .innerJoin(projects, eq(participants.projectId, projects.id))
    .innerJoin(users, and(eq(projects.orgId, users.orgId), eq(users.id, userId)))
    .where(eq(participants.id, participantId))
    .limit(1);
  if (!row) throw new HttpError(404, "参与方不存在或无权访问");
  return row;
}
