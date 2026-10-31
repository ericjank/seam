"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { apiRequest, errorMessage } from "@/lib/client-api";

type Props = {
  collaborations: Array<{ collaboration: { id: string; title: string; type: string; status: string; objective: string; updatedAt: string | Date }; project: { id: string; name: string } }>;
  projects: Array<{ project: { id: string; name: string }; agent: { id: string; name: string } | null }>;
};

const typeNames: Record<string, string> = {
  "api-integration": "接口对接", "event-integration": "事件对接", "data-contract": "数据契约",
  "release-coordination": "发布协调", custom: "自定义协作",
};

export function CollaborationList({ collaborations, projects }: Props) {
  const router = useRouter();
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState("");
  const uniqueProjects = Array.from(new Map(projects.map((row) => [row.project.id, row.project])).values());
  const [projectId, setProjectId] = useState(uniqueProjects[0]?.id ?? "");
  const agents = projects.filter((row) => row.project.id === projectId && row.agent);
  return <div className="stack">
    <div className="page-header"><div><h1>项目协作</h1><p className="muted">让各项目 Agent 直接协商，而不是由人复制转发。</p></div><button className="btn" onClick={() => setCreating(!creating)}>新建协作</button></div>
    {error && <div className="notice error">{error}</div>}
    {creating && <section className="card"><h2>创建多方协作</h2>
      <form className="form-grid" onSubmit={async (event) => {
        event.preventDefault();
        const data = Object.fromEntries(new FormData(event.currentTarget));
        try {
          const result = await apiRequest("/api/collaborations", data);
          router.push(`/collaborations/${result.id}`);
        } catch (err) { setError(errorMessage(err)); }
      }}>
        <div className="field"><label>协作标题</label><input name="title" required placeholder="订单页与订单服务接口对接" /></div>
        <div className="field"><label>协作类型</label><select name="type">{Object.entries(typeNames).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></div>
        <div className="field wide"><label>目标与验收背景</label><textarea name="objective" required placeholder="说明要完成的业务目标、边界和期望结果" /></div>
        <div className="field"><label>发起项目</label><select name="projectId" value={projectId} onChange={(e) => setProjectId(e.target.value)} required>{uniqueProjects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}</select></div>
        <div className="field"><label>发起 Agent</label><select name="agentId"><option value="">稍后指定</option>{agents.map((row) => <option key={row.agent?.id} value={row.agent?.id}>{row.agent?.name}</option>)}</select></div>
        <div className="wide"><button className="btn" disabled={!uniqueProjects.length}>创建并邀请参与方</button></div>
      </form>
    </section>}
    <div className="grid grid-3">
      {collaborations.map(({ collaboration, project }) => <Link href={`/collaborations/${collaboration.id}`} className="card" key={`${collaboration.id}-${project.id}`}>
        <div className="row-between"><span className="badge badge-blue">{typeNames[collaboration.type]}</span><span className={`badge ${collaboration.status === "completed" ? "badge-green" : ""}`}>{collaboration.status}</span></div>
        <h2 style={{ marginTop: 16 }}>{collaboration.title}</h2>
        <p className="muted">{collaboration.objective.slice(0, 120)}</p>
        <div className="small muted">经由 {project.name} · {new Date(collaboration.updatedAt).toLocaleString("zh-CN")}</div>
      </Link>)}
    </div>
    {!collaborations.length && <div className="empty">还没有协作。创建后邀请其他独立项目加入。</div>}
  </div>;
}
