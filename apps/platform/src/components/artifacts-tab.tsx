"use client";

import { useAction } from "./use-action";
import type { CollaborationData } from "./detail-types";

export function ArtifactsTab({ data }: { data: CollaborationData }) {
  const { run, error, busy } = useAction();
  const id = data.collaboration.id;
  return <div className="stack">
    {error && <div className="notice error">{error}</div>}
    <section className="card"><h2>发布产物新版本</h2>
      <form className="form-grid" onSubmit={async (event) => {
        event.preventDefault();
        const form = event.currentTarget;
        try { await run(`/api/collaborations/${id}/artifacts`, Object.fromEntries(new FormData(form))); form.reset(); } catch {}
      }}>
        <div className="field"><label>标题</label><input name="title" required placeholder="订单 API 契约" /></div>
        <div className="field"><label>类型</label><select name="type"><option value="openapi">OpenAPI</option><option value="asyncapi">AsyncAPI</option><option value="json-schema">JSON Schema</option><option value="markdown">Markdown</option><option value="test-plan">测试计划</option><option value="test-report">测试报告</option><option value="custom">自定义</option></select></div>
        <div className="field"><label>更新已有产物（可选）</label><select name="artifactId"><option value="">创建新产物</option>{data.artifacts.map((artifact) => <option key={artifact.id} value={artifact.id}>{artifact.title} · 当前 v{artifact.currentVersion}</option>)}</select></div>
        <div className="field"><label>代表参与方（可选）</label><select name="participantId"><option value="">以用户身份发布</option>{data.participants.filter((row) => row.participant.status === "active").map((row) => <option key={row.participant.id} value={row.participant.id}>{row.project.name}</option>)}</select></div>
        <div className="field wide"><label>内容</label><textarea name="content" required style={{ minHeight: 220 }} placeholder={'{"openapi":"3.1.0","info":{"title":"Orders","version":"1.0.0"},"paths":{}}'} /></div>
        <div className="wide"><button className="btn" disabled={busy}>发布并重新计算审批</button></div>
      </form>
    </section>
    {data.artifacts.map((artifact) => <section className="card" key={artifact.id}>
      <div className="card-header"><div><h2>{artifact.title}</h2><span className="small muted">{artifact.type} · {artifact.id}</span></div><span className="badge badge-blue">v{artifact.currentVersion}</span></div>
      <div className="stack">{artifact.versions.slice().reverse().map((version) => <details key={version.id} open={version.version === artifact.currentVersion}>
        <summary>v{version.version} · {new Date(version.createdAt).toLocaleString("zh-CN")} · hash {version.contentHash.slice(0, 12)}</summary>
        <div className="code" style={{ marginTop: 12, maxHeight: 420 }}>{version.content}</div>
      </details>)}</div>
    </section>)}
    {!data.artifacts.length && <div className="empty">尚未发布契约、文档或其他协作产物。</div>}
  </div>;
}
