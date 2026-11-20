"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { apiRequest, errorMessage } from "@/lib/client-api";

type ProjectRow = {
  project: { id: string; name: string; slug: string; description: string };
  agent: { id: string; name: string; adapter: string; status: string; lastSeenAt: string | Date | null } | null;
  unused: boolean;
};

export function ProjectManager({ rows, archived, role }: {
  rows: ProjectRow[];
  archived: boolean;
  role: "owner" | "member" | "viewer";
}) {
  const router = useRouter();
  const [busy, startTransition] = useTransition();
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [token, setToken] = useState<{ agentId: string; value: string } | null>(null);
  const byProject = new Map<string, ProjectRow["project"] & { unused: boolean; agents: NonNullable<ProjectRow["agent"]>[] }>();
  for (const { project, unused, agent } of rows) {
    const entry = byProject.get(project.id) ?? { ...project, unused, agents: [] };
    if (agent) entry.agents.push(agent);
    byProject.set(project.id, entry);
  }
  const projects = Array.from(byProject.values());
  function run(path: string, body: unknown, method: string, onSuccess: () => void) {
    setError("");
    setNotice("");
    startTransition(async () => {
      try {
        const data = await apiRequest(path, body, method);
        if (data.agent) setToken({ agentId: data.agent.id, value: data.agent.token });
        onSuccess();
        router.refresh();
      } catch (err) { setError(errorMessage(err)); }
    });
  }
  return <div className="stack">
    {error && <div className="notice error" role="alert">{error}</div>}
    {notice && <div className="notice success" role="status">{notice}</div>}
    {token && <div className="notice success" data-sensitive>
      <strong>Agent Token 只显示这一次，请立即保存。</strong>
      <div className="code">SEAM_AGENT_ID={token.agentId}{"\n"}SEAM_AGENT_TOKEN={token.value}{"\n"}SEAM_PLATFORM_URL=http://localhost:3000{"\n"}SEAM_PROJECT_ROOT=/path/to/private/project</div>
    </div>}
    {!archived && role !== "viewer" && <div className="grid grid-2">
      <section className="card">
        <h2>新建项目</h2>
        <form className="stack" onSubmit={(event) => {
          event.preventDefault();
          const form = event.currentTarget;
          const data = new FormData(form);
          run("/api/projects", Object.fromEntries(data), "POST", () => form.reset());
        }}>
          <div className="field"><label>项目名称</label><input name="name" required placeholder="例如：订单前端" /></div>
          <div className="field"><label>说明</label><textarea name="description" placeholder="项目职责与对接范围" /></div>
          <button className="btn" disabled={busy}>创建项目</button>
        </form>
      </section>
      <section className="card">
        <h2>注册本地 Agent</h2>
        <form className="stack" onSubmit={(event) => {
          event.preventDefault();
          const form = event.currentTarget;
          run("/api/agents", Object.fromEntries(new FormData(form)), "POST", () => form.reset());
        }}>
          <div className="field"><label>所属项目</label><select name="projectId" required>{projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}</select></div>
          <div className="field"><label>Agent 名称</label><input name="name" required placeholder="backend-ai" /></div>
          <div className="field"><label>适配器</label><select name="adapter"><option value="codex-app-server">Codex 持久对话（推荐）</option><option value="claude-code">Claude Code</option><option value="codex">Codex CLI</option><option value="generic-cli">通用 CLI</option><option value="mock">Mock（联调测试）</option></select></div>
          <button className="btn" disabled={busy || !projects.length}>生成 Connector 凭据</button>
        </form>
      </section>
    </div>}
    <div className="grid grid-2">
      {projects.map((project) => <section className="card" key={project.id}>
        <div className="card-header"><h2>{project.name}</h2><span className="badge">私有项目</span></div>
        <p className="muted">{project.description || "尚未填写项目说明"}</p>
        <div className="small muted">项目 ID</div><div className="code">{project.id}</div>
        {project.agents.length ? <>
          <h3 style={{ marginTop: 18 }}>Agents</h3>
          <div className="list">{project.agents.map((agent) => <div className="list-item row-between" key={agent.id}>
            <div><strong>{agent.name}</strong><div className="small muted">{agent.adapter} · {agent.id}</div></div>
            <span className={`badge ${agent.status === "online" ? "badge-green" : ""}`}>{agent.status}</span>
          </div>)}</div>
        </> : <p className="small muted">尚未注册 Agent</p>}
        {role !== "viewer" && <div className="row project-actions">
          <button className="btn btn-small btn-secondary" disabled={busy}
            title={archived ? "重新用于注册 Agent 和发起协作" : "从使用中列表收起，已有协作可继续"}
            onClick={() => {
              run(`/api/projects/${project.id}`, { archived: !archived }, "PATCH", () => {
                setNotice(archived ? `已恢复「${project.name}」。` : `已归档「${project.name}」，可在“已归档”中恢复。`);
              });
            }}>{archived ? "恢复项目" : "归档项目"}</button>
          {role === "owner" && project.unused && <button className="btn btn-small btn-danger" disabled={busy} onClick={() => {
            if (window.confirm(`永久删除「${project.name}」？此操作无法撤销。`)) {
              run(`/api/projects/${project.id}`, undefined, "DELETE", () => setNotice(`已删除「${project.name}」。`));
            }
          }}>永久删除</button>}
        </div>}
      </section>)}
    </div>
    {!projects.length && <div className="empty">{archived ? "暂无已归档项目。" : <>
      暂无使用中的项目。<Link href="/projects?view=archived">查看已归档项目</Link>
    </>}</div>}
  </div>;
}
