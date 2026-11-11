"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { apiRequest, errorMessage } from "@/lib/client-api";

type ProjectRow = {
  project: { id: string; name: string; slug: string; description: string };
  agent: { id: string; name: string; adapter: string; status: string; lastSeenAt: string | Date | null } | null;
};

export function ProjectManager({ rows }: { rows: ProjectRow[] }) {
  const router = useRouter();
  const [error, setError] = useState("");
  const [token, setToken] = useState<{ agentId: string; value: string } | null>(null);
  const projects = Array.from(new Map(rows.map((row) => [row.project.id, row.project])).values());
  async function run(path: string, body: unknown) {
    setError("");
    try {
      const data = await apiRequest(path, body);
      if (data.agent) setToken({ agentId: data.agent.id, value: data.agent.token });
      router.refresh();
    } catch (err) { setError(errorMessage(err)); }
  }
  return <div className="stack">
    {error && <div className="notice error">{error}</div>}
    {token && <div className="notice success">
      <strong>Agent Token 只显示这一次，请立即保存。</strong>
      <div className="code">SEAM_AGENT_ID={token.agentId}{"\n"}SEAM_AGENT_TOKEN={token.value}{"\n"}SEAM_PLATFORM_URL=http://localhost:3000{"\n"}SEAM_PROJECT_ROOT=/path/to/private/project</div>
    </div>}
    <div className="grid grid-2">
      <section className="card">
        <h2>新建项目</h2>
        <form className="stack" onSubmit={(event) => {
          event.preventDefault();
          const form = event.currentTarget;
          const data = new FormData(form);
          void run("/api/projects", Object.fromEntries(data)).then(() => form.reset());
        }}>
          <div className="field"><label>项目名称</label><input name="name" required placeholder="例如：订单前端" /></div>
          <div className="field"><label>说明</label><textarea name="description" placeholder="项目职责与对接范围" /></div>
          <button className="btn">创建项目</button>
        </form>
      </section>
      <section className="card">
        <h2>注册本地 Agent</h2>
        <form className="stack" onSubmit={(event) => {
          event.preventDefault();
          const form = event.currentTarget;
          void run("/api/agents", Object.fromEntries(new FormData(form))).then(() => form.reset());
        }}>
          <div className="field"><label>所属项目</label><select name="projectId" required>{projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}</select></div>
          <div className="field"><label>Agent 名称</label><input name="name" required placeholder="backend-ai" /></div>
          <div className="field"><label>适配器</label><select name="adapter"><option value="codex-app-server">Codex 持久对话（推荐）</option><option value="claude-code">Claude Code</option><option value="codex">Codex CLI</option><option value="generic-cli">通用 CLI</option><option value="mock">Mock（联调测试）</option></select></div>
          <button className="btn" disabled={!projects.length}>生成 Connector 凭据</button>
        </form>
      </section>
    </div>
    <div className="grid grid-2">
      {projects.map((project) => <section className="card" key={project.id}>
        <div className="card-header"><h2>{project.name}</h2><span className="badge">私有项目</span></div>
        <p className="muted">{project.description || "尚未填写项目说明"}</p>
        <div className="small muted">项目 ID</div><div className="code">{project.id}</div>
        <h3 style={{ marginTop: 18 }}>Agents</h3>
        <div className="list">
          {rows.filter((row) => row.project.id === project.id && row.agent).map((row) => <div className="list-item row-between" key={row.agent?.id}>
            <div><strong>{row.agent?.name}</strong><div className="small muted">{row.agent?.adapter} · {row.agent?.id}</div></div>
            <span className={`badge ${row.agent?.status === "online" ? "badge-green" : ""}`}>{row.agent?.status}</span>
          </div>)}
        </div>
      </section>)}
    </div>
    {!projects.length && <div className="empty">先创建一个项目，再为它注册本地 Agent。</div>}
  </div>;
}
