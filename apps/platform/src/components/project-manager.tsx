"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { apiRequest, errorMessage } from "@/lib/client-api";
import { ProjectDialog, type ProjectDialogAction } from "./project-dialog";

type Project = { id: string; name: string; description: string };
type Agent = { id: string; name: string; adapter: string; status: string };
type ProjectRow = { project: Project; agent: Agent | null; unused: boolean };

const agentStatuses: Record<string, string> = { online: "在线", offline: "离线", busy: "忙碌", error: "异常" };

export function ProjectManager({ rows, archived, role }: {
  rows: ProjectRow[];
  archived: boolean;
  role: "owner" | "member" | "viewer";
}) {
  const router = useRouter();
  const [busy, startTransition] = useTransition();
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [dialog, setDialog] = useState<ProjectDialogAction | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const editable = role !== "viewer";
  const byProject = new Map<string, Project & { unused: boolean; agents: Agent[] }>();
  for (const { project, unused, agent } of rows) {
    const entry = byProject.get(project.id) ?? { ...project, unused, agents: [] };
    if (agent) entry.agents.push(agent);
    byProject.set(project.id, entry);
  }

  function saved(message: string) {
    setError("");
    setNotice(message);
    router.refresh();
  }

  function changeProject(project: Project, operation: "archive" | "restore" | "delete") {
    if (operation === "delete" && !window.confirm(`永久删除「${project.name}」？此操作无法撤销。`)) return;
    setError("");
    setNotice("");
    startTransition(async () => {
      try {
        const path = `/api/projects/${project.id}`;
        if (operation === "delete") {
          await apiRequest(path, undefined, "DELETE");
          saved(`已删除「${project.name}」。`);
        } else {
          await apiRequest(path, { archived: operation === "archive" }, "PATCH");
          saved(operation === "archive" ? `已归档「${project.name}」，可在“已归档”中恢复。` : `已恢复「${project.name}」。`);
        }
      } catch (err) { setError(errorMessage(err)); }
    });
  }

  return <>
    <header className="projects-header">
      <h1>项目与 Agent</h1>
      {editable && !archived && <button className="btn" aria-haspopup="dialog" disabled={busy}
        onClick={() => setDialog({ kind: "create" })}>新建项目</button>}
    </header>
    <nav className="tabs" aria-label="项目状态">
      <Link href="/projects" aria-current={archived ? undefined : "page"}>使用中</Link>
      <Link href="/projects?view=archived" aria-current={archived ? "page" : undefined}>已归档</Link>
    </nav>
    <div className="stack">
      {error && <div className="notice error" role="alert">{error}</div>}
      {notice && <div className="notice success" role="status">{notice}</div>}
      {byProject.size ? <ul className="project-list" aria-label="项目列表">
        {Array.from(byProject.values(), (project) => {
          const expanded = expandedId === project.id;
          const canDelete = role === "owner" && project.unused;
          const detailsId = `details-${project.id}`;
          return <li key={project.id}>
            <div className="project-overview">
              <div className="project-summary">
                <h2>{project.name}</h2>
                {project.description && <p className={expanded ? undefined : "project-excerpt"}>{project.description}</p>}
              </div>
              <span className="project-agent-count">{project.agents.length} 个 Agent</span>
              <div className="row project-row-actions">
                {editable && (archived
                  ? <button className="btn btn-secondary btn-small" disabled={busy} onClick={() => changeProject(project, "restore")}>恢复项目</button>
                  : <button className="btn btn-secondary btn-small" aria-haspopup="dialog" disabled={busy}
                    onClick={() => setDialog({ kind: "register", project })}>注册 Agent</button>)}
                <button className="project-disclosure" aria-expanded={expanded} aria-controls={detailsId}
                  onClick={() => setExpandedId(expanded ? null : project.id)}>{expanded ? "收起详情" : "项目详情"}</button>
              </div>
            </div>
            <div id={detailsId} hidden={!expanded}>
              {expanded && <div className="project-details stack">
                <div className="row project-identity"><span className="badge">私有项目</span>
                  <span>项目 ID <code>{project.id}</code></span></div>
                {project.agents.length ? <ul className="project-agents" aria-label="已注册 Agent">
                  {project.agents.map((agent) => <li key={agent.id}>
                    <div><strong>{agent.name}</strong><div className="small muted">{agent.adapter} · {agent.id}</div></div>
                    <span className={`badge ${agent.status === "online" ? "badge-green" : ""}`}>{agentStatuses[agent.status] ?? agent.status}</span>
                  </li>)}
                </ul> : <span className="small muted">尚未注册 Agent</span>}
                {editable && (!archived || canDelete) && <div className="row">
                  {!archived && <button className="btn btn-small btn-secondary" disabled={busy}
                    title="从使用中列表收起，已有协作可继续" onClick={() => changeProject(project, "archive")}>归档项目</button>}
                  {canDelete && <button className="btn btn-small btn-danger" disabled={busy}
                    onClick={() => changeProject(project, "delete")}>永久删除</button>}
                </div>}
              </div>}
            </div>
          </li>;
        })}
      </ul> : <div className="empty">{archived ? "暂无已归档项目。" : <>
        暂无使用中的项目。<Link href="/projects?view=archived">查看已归档项目</Link>
      </>}</div>}
    </div>
    {dialog && <ProjectDialog action={dialog} onDismiss={() => setDialog(null)} onSaved={saved} />}
  </>;
}
