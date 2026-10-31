"use client";

import { useAction } from "./use-action";
import type { CollaborationData } from "./detail-types";

export function NegotiationTab({ data }: { data: CollaborationData }) {
  const { run, error, busy } = useAction();
  const id = data.collaboration.id;
  return <div className="stack">
    {error && <div className="notice error">{error}</div>}
    <section className="card"><h2>发起结构化提案</h2>
      <form className="form-grid" onSubmit={async (event) => {
        event.preventDefault();
        const form = event.currentTarget;
        try { await run(`/api/collaborations/${id}/proposals`, { ...Object.fromEntries(new FormData(form)), operation: "create" }); form.reset(); } catch {}
      }}>
        <div className="field"><label>标题</label><input name="title" required placeholder="确认订单 API v1 契约" /></div>
        <div className="field"><label>关联产物</label><select name="artifactId"><option value="">不关联</option>{data.artifacts.map((artifact) => <option key={artifact.id} value={artifact.id}>{artifact.title} v{artifact.currentVersion}</option>)}</select></div>
        <div className="field"><label>审批规则</label><select name="approvalMode"><option value="required">必要参与方一致</option><option value="all">全部有效参与方一致</option></select></div>
        <div className="field"><label>代表参与方（可选）</label><select name="participantId"><option value="">以用户身份</option>{data.participants.filter((row) => row.participant.status === "active").map((row) => <option key={row.participant.id} value={row.participant.id}>{row.project.name}</option>)}</select></div>
        <div className="field wide"><label>提案内容</label><textarea name="body" required placeholder="说明需要各方确认的分工、契约、约束与验收标准" /></div>
        <div className="wide"><button className="btn" disabled={busy}>提交给各参与方</button></div>
      </form>
    </section>
    {data.proposals.map((proposal) => <section className="card" key={proposal.id}>
      <div className="card-header"><div><h2>{proposal.title}</h2><span className="small muted">{proposal.approvalMode === "all" ? "全体一致" : "必要参与方"} · {proposal.id}</span></div><span className={`badge ${proposal.status === "accepted" ? "badge-green" : proposal.status === "rejected" ? "badge-red" : "badge-amber"}`}>{proposal.status}</span></div>
      <p style={{ whiteSpace: "pre-wrap" }}>{proposal.body}</p>
      <div className="list">{data.participants.filter((row) => row.participant.status === "active").map((row) => {
        const approval = proposal.approvals.find((item) => item.participantId === row.participant.id);
        return <div className="row-between" key={row.participant.id}><span className="small">{row.project.name}</span><span className={`badge ${approval?.decision === "approved" ? "badge-green" : approval?.decision === "rejected" ? "badge-red" : ""}`}>{approval?.decision ?? "待确认"}</span></div>;
      })}</div>
      {proposal.status === "open" && <form className="row" style={{ marginTop: 14 }} onSubmit={async (event) => {
        event.preventDefault();
        const raw = new FormData(event.currentTarget);
        try { await run(`/api/collaborations/${id}/proposals`, { ...Object.fromEntries(raw), operation: "decide", proposalId: proposal.id }); } catch {}
      }}>
        <select name="participantId" required style={{ width: "auto" }}><option value="">代表项目…</option>{data.participants.filter((row) => row.participant.status === "active").map((row) => <option key={row.participant.id} value={row.participant.id}>{row.project.name}</option>)}</select>
        <select name="decision" defaultValue="approved" style={{ width: "auto" }}><option value="approved">同意</option><option value="rejected">拒绝</option></select>
        <input name="comment" placeholder="确认意见" /><button className="btn btn-secondary btn-small">提交决定</button>
      </form>}
    </section>)}
    {!data.proposals.length && <div className="empty">尚无提案。达成一致前，建议将契约与分工整理为提案并明确确认。</div>}
  </div>;
}
