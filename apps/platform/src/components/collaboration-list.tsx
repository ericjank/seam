"use client";

import { formatDateTime } from "@/lib/date-time";

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
  const [submitting, setSubmitting] = useState(false);
  const uniqueCollaborations = Array.from(new Map(collaborations.map((row) => [row.collaboration.id, row])).values());
  const uniqueProjects = Array.from(new Map(projects.map((row) => [row.project.id, row.project])).values());
  const [projectId, setProjectId] = useState(uniqueProjects[0]?.id ?? "");
  const [targetProjectId, setTargetProjectId] = useState(uniqueProjects[1]?.id ?? "");
  const agents = projects.filter((row) => row.project.id === projectId && row.agent);
  const targetAgents = projects.filter((row) => row.project.id === targetProjectId && row.agent);
  return <div className="stack">
    <div className="page-header"><div><h1>项目协作</h1><p className="muted">让各项目 Agent 直接协商，而不是由人复制转发。</p></div><button className="btn" onClick={() => setCreating(!creating)}>新建协作</button></div>
    {error && <div className="notice error">{error}</div>}
    {creating && <section className="card"><h2>提交自动对接任务</h2><p className="muted">选择两端项目并描述目标。双方 AI 自动起草和确认实施文档，管理员批准后开始实施。</p>
      <form className="form-grid" onSubmit={async (event) => {
        event.preventDefault();
        const data = Object.fromEntries(new FormData(event.currentTarget));
        setSubmitting(true);
        try {
          const result = await apiRequest("/api/collaborations", data);
          router.push(`/collaborations/${result.id}`);
        } catch (err) { setError(errorMessage(err)); } finally { setSubmitting(false); }
      }}>
        <div className="field wide"><label>想让各项目 AI 一起完成什么？</label><textarea name="objective" required placeholder="直接描述业务目标，AI 从各自项目提取接口、分工和测试信息，无需逐项填写" /></div>
        <div className="field"><label>发起项目</label><select name="projectId" value={projectId} onChange={(e) => { const next = e.target.value; setProjectId(next); if (targetProjectId === next) setTargetProjectId(uniqueProjects.find((project) => project.id !== next)?.id ?? ""); }} required>{uniqueProjects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}</select></div>
        <div className="field"><label>发起 Agent</label><select key={projectId} name="agentId"><option value="">自动选择项目唯一 Agent</option>{agents.map((row) => <option key={row.agent?.id} value={row.agent?.id}>{row.agent?.name}</option>)}</select></div>
        <div className="field"><label>对接项目</label><select name="targetProjectId" value={targetProjectId} onChange={(event) => setTargetProjectId(event.target.value)} required><option value="">选择另一端项目</option>{uniqueProjects.filter((project) => project.id !== projectId).map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}</select></div>
        <div className="field"><label>对接 Agent</label><select key={targetProjectId} name="targetAgentId"><option value="">自动选择项目唯一 Agent</option>{targetAgents.map((row) => <option key={row.agent!.id} value={row.agent!.id}>{row.agent!.name}</option>)}</select></div>
        <details className="wide"><summary>可选设置</summary><div className="field"><label>协作标题</label><input name="title" placeholder="留空时从目标生成" /></div><div className="field"><label>协作类型</label><select name="type">{Object.entries(typeNames).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></div></details>
        <div className="wide"><button className="btn" disabled={submitting || uniqueProjects.length < 2}>提交目标，开始自动协商</button></div>
      </form>
    </section>}
    <div className="grid grid-3">
      {uniqueCollaborations.map(({ collaboration, project }) => <Link href={`/collaborations/${collaboration.id}`} className="card" key={`${collaboration.id}-${project.id}`}>
        <div className="row-between"><span className="badge badge-blue">{typeNames[collaboration.type]}</span><span className={`badge ${collaboration.status === "completed" ? "badge-green" : ""}`}>{collaboration.status}</span></div>
        <h2 style={{ marginTop: 16 }}>{collaboration.title}</h2>
        <p className="muted">{collaboration.objective.slice(0, 120)}</p>
        <div className="small muted">经由 {project.name} · {formatDateTime(collaboration.updatedAt)}</div>
      </Link>)}
    </div>
    {!collaborations.length && <div className="empty">还没有协作。创建后邀请其他独立项目加入。</div>}
  </div>;
}
