import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth";
import { listProjects } from "@/services/projects";
import { ProjectManager } from "@/components/project-manager";

export default async function ProjectsPage() {
  const current = await getCurrentUser();
  if (!current) redirect("/login");
  const rows = await listProjects(current.user.id);
  return <>
    <div className="page-header"><div><h1>项目与 Agent</h1><p className="muted">每个 Agent 通过本地 Connector 接入，平台不读取项目源码。</p></div></div>
    <ProjectManager rows={rows} />
  </>;
}
