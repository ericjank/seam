"use client";

import { formatDateTime } from "@/lib/date-time";

import { useAction } from "./use-action";
import type { CollaborationData } from "./detail-types";

export function AcceptanceTab({ data }: { data: CollaborationData }) {
  const { run, error, busy } = useAction();
  const id = data.collaboration.id;
  return <div className="stack">
    {error && <div className="notice error">{error}</div>}
    <section className="card"><h2>由 Connector 执行本地测试</h2>
      <p className="muted">仅运行该项目 Connector 上预先配置的 SEAM_TEST_COMMAND，平台不会远程下发命令。可配置 Pact、契约测试或项目测试脚本。</p>
      <form className="form-grid" onSubmit={async (event) => {
        event.preventDefault();
        try { await run(`/api/collaborations/${id}/test-runs`, Object.fromEntries(new FormData(event.currentTarget))); } catch {}
      }}>
        <div className="field"><label>执行项目</label><select name="participantId">{data.participants.filter((row) => row.participant.status === "active" && row.participant.agentId).map((row) => <option key={row.participant.id} value={row.participant.id}>{row.project.name}</option>)}</select></div>
        <div className="field"><label>关联任务（可选）</label><select name="workItemId"><option value="">整个协作</option>{data.workItems.map((item) => <option key={item.id} value={item.id}>{item.title}</option>)}</select></div>
        <div className="field"><label>关联产物（可选）</label><select name="artifactId"><option value="">无</option>{data.artifacts.map((artifact) => <option key={artifact.id} value={artifact.id}>{artifact.title} v{artifact.currentVersion}</option>)}</select></div>
        <div className="field" style={{ justifyContent: "end" }}><button className="btn" disabled={busy}>派发本地测试</button></div>
      </form>
    </section>
    <section className="card"><h2>提交测试与验收证据</h2>
      <form className="form-grid" onSubmit={async (event) => {
        event.preventDefault();
        const form = event.currentTarget;
        const raw = Object.fromEntries(new FormData(form));
        try {
          await run(`/api/collaborations/${id}/acceptance`, { ...raw, evidence: raw.evidence ? JSON.parse(String(raw.evidence)) : {} });
          form.reset();
        } catch {}
      }}>
        <div className="field"><label>提交项目</label><select name="participantId">{data.participants.filter((row) => row.participant.status === "active").map((row) => <option key={row.participant.id} value={row.participant.id}>{row.project.name}</option>)}</select></div>
        <div className="field"><label>结果</label><select name="status"><option value="passed">通过</option><option value="failed">未通过</option></select></div>
        <div className="field"><label>关联任务（可选）</label><select name="workItemId"><option value="">整个协作</option>{data.workItems.map((item) => <option key={item.id} value={item.id}>{item.title}</option>)}</select></div>
        <div className="field"><label>关联产物（可选）</label><select name="artifactId"><option value="">无</option>{data.artifacts.map((artifact) => <option key={artifact.id} value={artifact.id}>{artifact.title} v{artifact.currentVersion}</option>)}</select></div>
        <div className="field wide"><label>测试摘要</label><textarea name="summary" required placeholder="实际执行的命令、覆盖范围和结果；不要提交本地日志全文" /></div>
        <div className="field wide"><label>结构化证据（JSON，可选）</label><textarea name="evidence" placeholder={'{"command":"pnpm test:contract","passed":12,"failed":0}'} /></div>
        <div className="wide"><button className="btn" disabled={busy}>提交证据并重新计算验收</button></div>
      </form>
    </section>
    {data.acceptanceRuns.map((runItem) => <section className="card" key={runItem.id}>
      <div className="card-header"><h2>{data.participants.find((row) => row.participant.id === runItem.participantId)?.project.name}</h2><span className={`badge ${runItem.status === "passed" ? "badge-green" : "badge-red"}`}>{runItem.status}</span></div>
      <p>{runItem.summary}</p><div className="code">{JSON.stringify(runItem.evidence, null, 2)}</div>
      <p className="small muted">{formatDateTime(runItem.createdAt)} · 产物版本 {runItem.artifactVersionId ?? "未关联"}</p>
    </section>)}
    {!data.acceptanceRuns.length && <div className="empty">尚无验收证据。Agent 单方面的“已完成”声明不会替代真实测试。</div>}
  </div>;
}
