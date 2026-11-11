import { desc, eq } from "drizzle-orm";
import { db } from "@/db";
import { agents, projects, users } from "@/db/schema";
import { hashToken, newId, newToken } from "@/lib/ids";
import { requireProjectAccess } from "@/lib/access";
import { audit } from "@/lib/audit";

function slugify(value: string) {
  const slug = value.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]+/g, "-").replace(/^-|-$/g, "");
  return `${slug || "project"}-${newId().slice(0, 8)}`;
}

export async function listProjects(userId: string) {
  return db.select({ project: projects, agent: agents })
    .from(projects)
    .innerJoin(users, eq(projects.orgId, users.orgId))
    .leftJoin(agents, eq(projects.id, agents.projectId))
    .where(eq(users.id, userId))
    .orderBy(desc(projects.createdAt));
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
  await requireProjectAccess(userId, input.projectId, true);
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
}
