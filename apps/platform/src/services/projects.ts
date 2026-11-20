import { and, desc, eq, isNotNull, isNull, notExists, sql } from "drizzle-orm";
import { db, withTransaction } from "@/db";
import { agents, participants, projects, users } from "@/db/schema";
import { hashToken, newId, newToken } from "@/lib/ids";
import { requireProjectAccess } from "@/lib/access";
import { audit } from "@/lib/audit";
import { HttpError } from "@/lib/http";

function slugify(value: string) {
  const slug = value.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]+/g, "-").replace(/^-|-$/g, "");
  return `${slug || "project"}-${newId().slice(0, 8)}`;
}

function unusedProject() {
  const agent = db.select({ id: agents.id }).from(agents).where(eq(agents.projectId, projects.id));
  const participant = db.select({ id: participants.id }).from(participants).where(eq(participants.projectId, projects.id));
  return sql<boolean>`${notExists(agent)} AND ${notExists(participant)}`.mapWith(Boolean);
}

export async function listProjects(userId: string, view: "active" | "archived" = "active") {
  return db.select({
    project: projects,
    agent: {
      id: agents.id, projectId: agents.projectId, name: agents.name, adapter: agents.adapter,
      status: agents.status, lastSeenAt: agents.lastSeenAt, createdAt: agents.createdAt, updatedAt: agents.updatedAt,
    },
    unused: unusedProject(),
  })
    .from(projects)
    .innerJoin(users, eq(projects.orgId, users.orgId))
    .leftJoin(agents, eq(projects.id, agents.projectId))
    .where(and(eq(users.id, userId), view === "archived" ? isNotNull(projects.archivedAt) : isNull(projects.archivedAt)))
    .orderBy(desc(projects.createdAt));
}

// Hold the project lock until the state change or the new reference commits.
async function lockProject(projectId: string, mode: "share" | "update") {
  const [project] = await db.select({ archivedAt: projects.archivedAt }).from(projects)
    .where(eq(projects.id, projectId)).for(mode);
  if (!project) throw new HttpError(404, "项目不存在");
  return project;
}

export async function requireActiveProject(projectId: string) {
  const project = await lockProject(projectId, "share");
  if (project.archivedAt) throw new HttpError(409, "项目已归档，请先恢复项目");
}

export async function setProjectArchived(userId: string, projectId: string, archived: boolean) {
  await withTransaction(async () => {
    await requireProjectAccess(userId, projectId, true);
    const project = await lockProject(projectId, "update");
    if (Boolean(project.archivedAt) === archived) return;
    const now = new Date();
    await db.update(projects).set({ archivedAt: archived ? now : null, updatedAt: now }).where(eq(projects.id, projectId));
    await audit({ actorType: "user", actorId: userId, action: archived ? "project.archived" : "project.restored", metadata: { projectId } });
  });
}

export async function deleteUnusedProject(userId: string, projectId: string) {
  await withTransaction(async () => {
    const { role } = await requireProjectAccess(userId, projectId, true);
    if (role !== "owner") throw new HttpError(403, "只有组织所有者可以永久删除项目");
    await lockProject(projectId, "update");
    const [result] = await db.delete(projects).where(and(eq(projects.id, projectId), unusedProject()));
    if (!result.affectedRows) throw new HttpError(409, "项目已有 Agent 或协作记录，可归档保留");
    await audit({ actorType: "user", actorId: userId, action: "project.deleted", metadata: { projectId } });
  });
}

export async function createProject(userId: string, input: { name: string; description?: string }) {
  const [user] = await db.query.users.findMany({ where: (table, { eq }) => eq(table.id, userId), limit: 1 });
  if (!user || user.role === "viewer") throw new Error("无权创建项目");
  const project = {
    id: newId(),
    orgId: user.orgId,
    name: input.name,
    slug: slugify(input.name),
    description: input.description ?? "",
  };
  await db.insert(projects).values(project);
  return project;
}

export async function createAgent(
  userId: string,
  input: { projectId: string; name: string; adapter: "claude-code" | "codex" | "codex-app-server" | "generic-cli" | "mock" },
) {
  return withTransaction(async () => {
    await requireProjectAccess(userId, input.projectId, true);
    await requireActiveProject(input.projectId);
    const token = newToken();
    const agent = {
      id: newId(),
      projectId: input.projectId,
      name: input.name,
      adapter: input.adapter,
      tokenHash: hashToken(token),
    };
    await db.insert(agents).values(agent);
    await audit({ actorType: "user", actorId: userId, action: "agent.created", metadata: { projectId: input.projectId, agentId: agent.id } });
    return { ...agent, token };
  });
}
