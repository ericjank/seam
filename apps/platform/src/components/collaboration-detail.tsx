"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useAction } from "./use-action";
import type { CollaborationData } from "./detail-types";
import { ArtifactsTab } from "./artifacts-tab";
import { NegotiationTab } from "./negotiation-tab";
import { WorkTab } from "./work-tab";
import { GrantsTab } from "./grants-tab";
import { AcceptanceTab } from "./acceptance-tab";

const tabs = [
  ["chat", "对话"], ["proposals", "提案与确认"], ["artifacts", "产物"], ["work", "任务"], ["credentials", "联调凭据"], ["acceptance", "验收"], ["audit", "审计"],
] as const;

export function CollaborationDetail({ data }: { data: CollaborationData }) {
  const [tab, setTab] = useState<(typeof tabs)[number][0]>("chat");
  const { run, error, busy } = useAction();
  const router = useRouter();
  const id = data.collaboration.id;
  useEffect(() => {
    const events = new EventSource(`/api/collaborations/${id}/events`);
    let initial = true;
    let timer: ReturnType<typeof setTimeout>;
    events.onmessage = () => {
      if (initial) { initial = false; return; }
      clearTimeout(timer);
      timer = setTimeout(() => router.refresh(), 500);
    };
    return () => { events.close(); clearTimeout(timer); };
  }, [id, router]);
  return <div className="stack">
    <div className="page-header"><div><div className="row"><span className="badge badge-blue">{data.collaboration.type}</span><span className="badge">{data.collaboration.status}</span></div><h1 style={{ marginTop: 12 }}>{data.collaboration.title}</h1><p className="muted">{data.collaboration.objective}</p></div><button className="btn" disabled={busy} onClick={() => void run(`/api/collaborations/${id}/dispatch`, {}).catch(() => undefined)}>运行一轮 Agent 协商</button></div>
    {error && <div className="notice error">{error}</div>}
    <section className="card"><div className="card-header"><h2>参与项目</h2><span className="small muted">协商轮次 {data.collaboration.negotiationRound}/{data.collaboration.maxNegotiationRounds}</span></div>
      <div className="grid grid-3">{data.participants.map((row) => <div className="list-item" key={row.participant.id}>
        <div className="row-between"><strong>{row.project.name}</strong><span className={`badge ${row.participant.status === "active" ? "badge-green" : "badge-amber"}`}>{row.participant.status}</span></div>
        <p className="small muted">{row.participant.role} · {row.agent ? `${row.agent.name}（${row.agent.status}）` : "未绑定 Agent"}</p>
        <div className="small muted">参与方 ID：{row.participant.id}</div>
        {row.participant.status === "invited" && <button className="btn btn-secondary btn-small" style={{ marginTop: 10 }} onClick={() => void run(`/api/participants/${row.participant.id}/accept`, {}).catch(() => undefined)}>代表该项目接受邀请</button>}
      </div>)}</div>
      <details style={{ marginTop: 16 }}><summary>邀请另一个独立项目</summary>
        <form className="form-grid" style={{ marginTop: 14 }} onSubmit={async (event) => {
          event.preventDefault();
          const form = event.currentTarget;
          try { await run(`/api/collaborations/${id}/participants`, Object.fromEntries(new FormData(form))); form.reset(); } catch {}
        }}>
          <div className="field"><label>目标项目 ID</label><input name="projectId" required placeholder="由项目所有者在项目页提供" /></div>
          <div className="field"><label>Agent ID（可选）</label><input name="agentId" /></div>
          <div className="field"><label>职责</label><select name="role"><option value="provider">提供方</option><option value="consumer">消费方</option><option value="reviewer">评审方</option><option value="participant">普通参与方</option></select></div>
          <div className="field" style={{ justifyContent: "end" }}><button className="btn">发送邀请</button></div>
        </form>
      </details>
    </section>
    <div className="tabs">{tabs.map(([value, label]) => <button key={value} className={tab === value ? "active" : ""} onClick={() => setTab(value)}>{label}</button>)}</div>
    {tab === "chat" && <section className="card"><h2>协作对话</h2>
      <div>{data.messages.map((message) => <div className="message" key={message.id}><div className="avatar">{message.authorName.slice(0, 1).toUpperCase()}</div><div className="message-body"><div className="row"><strong>{message.authorName}</strong><span className="badge">{message.kind}</span><span className="small muted">{new Date(message.createdAt).toLocaleString("zh-CN")}</span></div><p className="message-text">{message.body}</p></div></div>)}</div>
      <form className="row" style={{ marginTop: 18 }} onSubmit={async (event) => {
        event.preventDefault();
        const form = event.currentTarget;
        const body = new FormData(form).get("body");
        try { await run(`/api/collaborations/${id}/messages`, { body }); form.reset(); } catch {}
      }}><textarea name="body" required placeholder="补充协作背景或向所有 Agent 提问；不需要再复制给其他项目" style={{ minHeight: 70 }} /><button className="btn">发送</button></form>
    </section>}
    {tab === "proposals" && <NegotiationTab data={data} />}
    {tab === "artifacts" && <ArtifactsTab data={data} />}
    {tab === "work" && <WorkTab data={data} />}
    {tab === "credentials" && <GrantsTab data={data} />}
    {tab === "acceptance" && <AcceptanceTab data={data} />}
    {tab === "audit" && <section className="card"><h2>操作审计</h2><table className="table"><thead><tr><th>时间</th><th>操作者</th><th>事件</th><th>元数据</th></tr></thead><tbody>{data.auditEvents.map((event) => <tr key={event.id}><td>{new Date(event.createdAt).toLocaleString("zh-CN")}</td><td>{event.actorType}<br /><span className="small muted">{event.actorId}</span></td><td>{event.action}</td><td><div className="code">{JSON.stringify(event.metadata)}</div></td></tr>)}</tbody></table></section>}
  </div>;
}
