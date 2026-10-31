"use client";

import { useAction } from "./use-action";
import type { CollaborationData } from "./detail-types";

export function WorkTab({ data }: { data: CollaborationData }) {
  const { run, error, busy } = useAction();
  const id = data.collaboration.id;
  const participantName = (participantId: string | null) => data.participants.find((row) => row.participant.id === participantId)?.project.name ?? "未分配";
  return <div className="stack">
    {error && <div className="notice error">{error}</div>}
    <section className="card"><h2>创建任务</h2>
      <form className="form-grid" onSubmit={async (event) => {
        event.preventDefault();
        const form = event.currentTarget;
        const raw = new FormData(form);
        try {
          await run(`/api/collaborations/${id}/work-items`, {
            ...Object.fromEntries(raw), dependsOn: raw.getAll("dependsOn"), operation: "create",
          });
          form.reset();
        } catch {}
      }}>
        <div className="field"><label>任务标题</label><input name="title" required /></div>
        <div className="field"><label>负责项目</label><select name="assigneeParticipantId"><option value="">未分配</option>{data.participants.map((row) => <option key={row.participant.id} value={row.participant.id}>{row.project.name}</option>)}</select></div>
        <div className="field wide"><label>说明</label><textarea name="description" /></div>
        <div className="field"><label>优先级</label><select name="priority"><option value="normal">普通</option><option value="high">高</option><option value="critical">紧急</option><option value="low">低</option></select></div>
        <div className="field"><label>验收标准</label><input name="acceptanceCriteria" placeholder="契约测试通过且无破坏性变更" /></div>
        <div className="field wide"><label>前置任务</label><div className="row">{data.workItems.map((item) => <label className="badge" key={item.id}><input type="checkbox" name="dependsOn" value={item.id} style={{ width: "auto" }} />{item.title}</label>)}</div></div>
        <div className="wide"><button className="btn" disabled={busy}>添加任务</button></div>
      </form>
    </section>
    <div className="grid grid-2">{data.workItems.map((item) => <section className="card" key={item.id}>
      <div className="card-header"><h2>{item.title}</h2><span className={`badge ${item.status === "completed" ? "badge-green" : item.status === "blocked" ? "badge-red" : "badge-blue"}`}>{item.status}</span></div>
      <p className="muted">{item.description || "无说明"}</p>
      <p className="small">负责：{participantName(item.assigneeParticipantId)} · 优先级：{item.priority}</p>
      <p className="small muted">验收：{item.acceptanceCriteria || "按协作约定验收"}</p>
      {item.dependsOn.length > 0 && <p className="small muted">依赖 {item.dependsOn.length} 个前置任务</p>}
      <form className="row" onSubmit={async (event) => {
        event.preventDefault();
        const raw = new FormData(event.currentTarget);
        try { await run(`/api/collaborations/${id}/work-items`, { ...Object.fromEntries(raw), operation: "update", workItemId: item.id }); } catch {}
      }}>
        <select name="status" defaultValue={item.status} style={{ width: "auto" }}><option value="pending">待开始</option><option value="in_progress">实施中</option><option value="blocked">阻塞</option><option value="validating">验收中</option><option value="rejected">已拒绝</option></select>
        <input name="summary" placeholder="进度摘要（可选）" />
        <button className="btn btn-secondary btn-small">更新</button>
      </form>
    </section>)}</div>
    {!data.workItems.length && <div className="empty">还没有任务。可等待 Agent 分工，或由用户手动创建。</div>}
  </div>;
}
