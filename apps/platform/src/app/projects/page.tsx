import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth";
import { listProjects } from "@/services/projects";
import { ProjectManager } from "@/components/project-manager";

export default async function ProjectsPage({ searchParams }: { searchParams: Promise<{ view?: string }> }) {
  const current = await getCurrentUser();
  if (!current) redirect("/login");
  const archived = (await searchParams).view === "archived";
  const rows = await listProjects(current.user.id, archived ? "archived" : "active");
  return <ProjectManager key={String(archived)} rows={rows} archived={archived} role={current.user.role} />;
}
