"use client";

import { formatDateTime } from "@/lib/date-time";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useAction } from "./use-action";
import type { CollaborationData } from "./detail-types";
import { ArtifactsTab } from "./artifacts-tab";
import { NegotiationTab } from "./negotiation-tab";
import { WorkTab } from "./work-tab";
import { GrantsTab } from "./grants-tab";
import { LifecyclePanel } from "./lifecycle-panel";
import { AcceptanceTab } from "./acceptance-tab";

const tabs = [
  ["chat", "对话"], ["proposals", "提案与确认"], ["artifacts", "产物"], ["work", "任务"], ["credentials", "联调凭据"], ["acceptance", "验收"], ["audit", "审计"],
] as const;

export function CollaborationDetail({ data }: { data: CollaborationData }) {
  const [dispatchNotice, setDispatchNotice] = useState("");
  const [inviteProjectId, setInviteProjectId] = useState("");
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
  const projectChoices = Array.from(new Map(data.availableProjects.filter((row) =>
    !data.participants.some((p) => p.project.id === row.project.id)).map((row) => [row.project.id, row.project])).values());
  const inviteAgents = data.availableProjects.filter((row) => row.project.id === inviteProjectId && row.agent);
  const conversations = data.jobs.filter((job, index, all) => job.conversation && all.findIndex((other) => other.conversation?.threadId === job.conversation!.threadId) === index);
  const telemetry = data.jobs.flatMap((job) => job.telemetry ? [job.telemetry] : []).filter((item, index, all) => all.findIndex((other) => other.turnId === item.turnId) === index);
  return <div className="stack">
    <div className="page-header"><div><div className="row"><span className="badge badge-blue">{data.collaboration.type}</span><span className="badge">{data.collaboration.status}</span></div><h1 style={{ marginTop: 12 }}>{data.collaboration.title}</h1><p className="muted">{data.collaboration.objective}</p></div>{(!data.lifecycle || ["planning", "plan_confirmation", "executing"].includes(data.lifecycle.phase)) && <button className="btn btn-secondary" disabled={busy} onClick={() => void run(`/api/collaborations/${id}/dispatch`, { autoAdvance: true }).catch(() => undefined)}>{data.lifecycle ? "重试自动流程" : "继续推进"}</button>}</div>
    {error && <div className="notice error">{error}</div>}
    <LifecyclePanel data={data} run={run} busy={busy} />
    {(conversations.length > 0 || telemetry.length > 0) && <details className="card" aria-label="本机AI对话与用量"><summary>本机 AI 对话与用量 · {conversations.length} 个会话</summary>
      <p className="small muted">根据最近 {data.jobs.length} 条执行记录汇总；其中 {data.jobs.length - telemetry.length} 条未取得原生用量记录（可能未执行、非原生端或中断），不计为零成本。同一会话可包含多个修订，批次用于区分独立测试。字节量不等同于模型 token 或费用；未上报用量显示为未知。</p>
      {conversations.map((job) => <p key={job.conversation!.threadId}><a href={`codex://threads/${job.conversation!.threadId}`}>{job.conversation!.title}</a> · {job.conversation!.runLabel || "正式任务"} · 最近任务 {job.status}</p>)}
      {telemetry.map((item) => <details key={item.turnId}><summary>第 {item.revision} 版 · {item.phase} · 输入正文 {item.promptBytes} 字节 · token {item.tokenUsage?.turnDelta?.totalTokens ?? "未知"}</summary>
        <p>输出协议 {item.schemaBytes} 字节；命令输出 {item.commandOutputBytes} 字节；含资源读取的命令 {item.resourceReadCommands} 次、输出 {item.resourceCommandOutputBytes} 字节；上下文压缩 {item.contextCompacted ? "发生" : "未观察到"}。</p>
        <p>本轮新增缓存 {item.resourceStats.createdBytes} 字节；当前资源 {item.resourceStats.files} 份、{item.resourceStats.availableBytes} 字节；清理过期资源 {item.resourceStats.prunedFiles} 份。</p>
        {item.tokenUsage && <p>模型上报本会话累计 token {item.tokenUsage.threadTotal.totalTokens}；本轮差值输入 {item.tokenUsage.turnDelta?.inputTokens ?? "未知"}、缓存命中 {item.tokenUsage.turnDelta?.cachedInputTokens ?? "未知"}、输出 {item.tokenUsage.turnDelta?.outputTokens ?? "未知"}。累计值不重复相加。</p>}
      </details>)}
    </details>}
    <section className="card"><div className="card-header"><h2>参与项目</h2><span className="small muted">累计派发 {data.collaboration.negotiationRound} 批 · 每次最多 {data.collaboration.maxNegotiationRounds} 批</span></div>
      <div className="grid grid-3">{data.participants.map((row) => <div className="list-item" key={row.participant.id}>
        <div className="row-between"><strong>{row.project.name}</strong><span className={`badge ${row.participant.status === "active" ? "badge-green" : "badge-amber"}`}>{row.participant.status}</span></div>
        <p className="small muted">{row.participant.role} · {row.agent ? `${row.agent.name}（${row.agent.status}）` : "未绑定 Agent"}</p>
        {(() => {
          const capability = data.connectorCapabilities.find((item) => item.agentId === row.participant.agentId);
          return <div className="small muted">{capability ? `本机执行能力：${capability.adapter} · ${capability.executionMode === "workspace-write" ? "项目内可写" : capability.executionMode === "read-only" ? "只读，实施前需本机配置写入" : "权限由本地工具管理"} · ${capability.testConfigured ? "已配置本地测试" : "未配置本地测试命令"}` : "尚未上报执行能力，请在本机运行 Connector --doctor 并更新 Connector"}</div>;
        })()}
        {data.jobs.find((job) => job.agentId === row.participant.agentId && job.conversation)?.conversation && <a className="btn btn-secondary btn-small" href={`codex://threads/${data.jobs.find((job) => job.agentId === row.participant.agentId && job.conversation)!.conversation!.threadId}`}>打开本机 Codex 对话</a>}
        <details className="small muted"><summary>参与方标识</summary>{row.participant.id}</details>
        {row.participant.status === "invited" && <button className="btn btn-secondary btn-small" style={{ marginTop: 10 }} onClick={() => void run(`/api/participants/${row.participant.id}/accept`, {}).catch(() => undefined)}>代表该项目接受邀请</button>}
      </div>)}</div>
      <details style={{ marginTop: 16 }}><summary>邀请另一个独立项目</summary>
        <form className="form-grid" style={{ marginTop: 14 }} onSubmit={async (event) => {
          event.preventDefault();
          const form = event.currentTarget;
          try { await run(`/api/collaborations/${id}/participants`, Object.fromEntries(new FormData(form))); form.reset(); } catch {}
        }}>
          <div className="field"><label>目标项目</label><select value={inviteProjectId} onChange={(event) => setInviteProjectId(event.target.value)}><option value="">外部项目：填写项目 ID</option>{projectChoices.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}</select>{inviteProjectId ? <input type="hidden" name="projectId" value={inviteProjectId} /> : <input name="projectId" required placeholder="外部项目所有者提供的项目 ID" />}</div>
          <div className="field"><label>项目 Agent</label>{inviteProjectId ? <select key={inviteProjectId} name="agentId" defaultValue={inviteAgents.length === 1 ? inviteAgents[0]?.agent?.id : ""}><option value="">自动选择唯一 Agent</option>{inviteAgents.map((row) => <option key={row.agent!.id} value={row.agent!.id}>{row.agent!.name}</option>)}</select> : <input name="agentId" placeholder="可选：自动选择该项目唯一 Agent" />}</div>
          <div className="field"><label>职责</label><select name="role"><option value="provider">提供方</option><option value="consumer">消费方</option><option value="reviewer">评审方</option><option value="participant">普通参与方</option></select></div>
          <div className="field" style={{ justifyContent: "end" }}><button className="btn">发送邀请</button></div>
        </form>
      </details>
    </section>
    <div className="tabs">{tabs.filter(([value]) => !data.lifecycle || ["chat", "audit"].includes(value)).map(([value, label]) => <button key={value} className={tab === value ? "active" : ""} onClick={() => setTab(value)}>{label}</button>)}</div>
    {tab === "chat" && <section className="card"><h2>协作对话</h2>
      <p className="small muted">说一次目标，各端 AI 读取本地项目、复用已有资料并填写任务和产物。有新交接时自动推进，遇到缺失信息或执行失败会暂停。</p>
      {dispatchNotice && <div className="notice">{dispatchNotice}</div>}
      {data.jobs.length > 0 && <details style={{ marginBottom: 16 }}><summary>最近执行记录（{data.jobs.filter((job) => job.status === "failed").length} 项失败）</summary><div className="list">{data.jobs.map((job) => <div className="list-item" key={job.id}><strong>{data.participants.find((p) => p.participant.agentId === job.agentId)?.project.name ?? "项目 Agent"}</strong> · {job.status}<div className="small muted">{job.id} · 第 {job.attempts} 次领取</div>{job.status === "cancelled" && job.attempts > 0 && <p className="small muted">{job.cancellationAckAt ? "执行端已确认停止" : "等待执行端停止确认"}</p>}{job.error && <p className="message-text">{job.status === "cancelled" ? job.error.replace("，等待执行端停止确认", "") : job.error}</p>}</div>)}</div></details>}
      <div>{data.messages.map((message) => <div className="message" key={message.id}><div className="avatar">{message.authorName.slice(0, 1).toUpperCase()}</div><div className="message-body"><div className="row"><strong>{message.authorName}</strong><span className="badge">{message.kind}</span><span className="small muted">{formatDateTime(message.createdAt)}</span></div><p className="message-text">{message.body}</p></div></div>)}</div>
      {!data.lifecycle && <form className="row" style={{ marginTop: 18 }} onSubmit={async (event) => {
        event.preventDefault();
        const form = event.currentTarget;
        const body = new FormData(form).get("body");
        const dispatch = new FormData(form).get("dispatch") === "on";
        try {
          const result = await run(`/api/collaborations/${id}/messages`, { body, dispatch });
          setDispatchNotice(result.dispatchError ? `消息已保存；${result.dispatchError}` : dispatch ? "消息已交给项目 AI，可在执行记录中查看进度。" : "留言已保存。");
          form.reset();
        } catch {}
      }}><div style={{ flex: 1 }}><textarea name="body" required placeholder="告诉各端 AI 要完成什么，已有背景无需重复填写" style={{ minHeight: 70 }} /><label className="small row"><input type="checkbox" name="dispatch" defaultChecked style={{ width: "auto" }} />发送后自动交给 AI 推进</label></div><button className="btn" disabled={busy}>发送</button></form>}
    </section>}
    {tab === "proposals" && <NegotiationTab data={data} />}
    {tab === "artifacts" && <ArtifactsTab data={data} />}
    {tab === "work" && <WorkTab data={data} />}
    {tab === "credentials" && <GrantsTab data={data} />}
    {tab === "acceptance" && <AcceptanceTab data={data} />}
    {tab === "audit" && <section className="card"><h2>操作审计</h2><table className="table"><thead><tr><th>时间</th><th>操作者</th><th>事件</th><th>元数据</th></tr></thead><tbody>{data.auditEvents.map((event) => <tr key={event.id}><td>{formatDateTime(event.createdAt)}</td><td>{event.actorType}<br /><span className="small muted">{event.actorId}</span></td><td>{event.action}</td><td><div className="code">{JSON.stringify(event.metadata)}</div></td></tr>)}</tbody></table></section>}
  </div>;
}
