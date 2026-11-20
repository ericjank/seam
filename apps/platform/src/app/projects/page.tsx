import Link from "next/link";
import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth";
import { listProjects } from "@/services/projects";
import { ProjectManager } from "@/components/project-manager";

export default async function ProjectsPage({ searchParams }: { searchParams: Promise<{ view?: string }> }) {
  const current = await getCurrentUser();
  if (!current) redirect("/login");
  const archived = (await searchParams).view === "archived";
  const rows = await listProjects(current.user.id, archived ? "archived" : "active");
  return <>
    <div className="page-header"><div><h1>项目与 Agent</h1><p className="muted">每个 Agent 通过本地 Connector 接入，平台不读取项目源码。</p></div></div>
    <nav className="tabs" aria-label="项目状态">
      <Link href="/projects" aria-current={archived ? undefined : "page"}>使用中</Link>
      <Link href="/projects?view=archived" aria-current={archived ? "page" : undefined}>已归档</Link>
    </nav>
    <ProjectManager key={String(archived)} rows={rows} archived={archived} role={current.user.role} />
  </>;
}
