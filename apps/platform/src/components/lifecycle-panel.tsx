"use client";

import type { CollaborationData, ActionRunner } from "./detail-types";

const phases = [
  ["planning", "双方起草"], ["plan_confirmation", "双方确认"], ["awaiting_approval", "管理员批准"],
  ["executing", "自动实施"], ["awaiting_review", "查看报告"], ["terminated", "任务终止"],
];

export function LifecyclePanel({ data, run, busy }: { data: CollaborationData; run: ActionRunner; busy: boolean }) {
  const lifecycle = data.lifecycle;
  if (!lifecycle) return null;
  const path = `/api/collaborations/${data.collaboration.id}/lifecycle`;
  return <section className="card stack" aria-label="自动对接流程">
    <div className="row-between"><h2>自动对接 · 第 {lifecycle.revision} 轮</h2><span className="badge badge-blue">{phases.find(([phase]) => phase === lifecycle.phase)?.[1]}</span></div>
    <div className="row">{phases.map(([phase, label], index) => <span className={`badge ${phase === lifecycle.phase ? "badge-blue" : ""}`} key={phase}>{index + 1}. {label}</span>)}</div>
    <p className="muted">{lifecycle.phase === "planning" ? "两端 AI 正在读取各自项目并协商目标、接口、实施步骤与测试方案。此阶段为只读。" : lifecycle.phase === "plan_confirmation" ? "完整文档已生成，两端 AI 正在核对并确认同一版本。" : lifecycle.phase === "awaiting_approval" ? "双方已确认下方文档，等待管理员批准。批准后两端自动实施，无需逐项填写任务。" : lifecycle.phase === "executing" ? "两端正在按已批准文档修改各自项目并运行测试，完成后自动汇总报告。" : lifecycle.phase === "awaiting_review" ? "实施报告已汇总。可补充要求重新起草下一轮文档；满意后手动终止任务。" : "管理员已终止此任务，文档、报告和对话记录已保留。"}</p>
    <div className="small muted">计划 {lifecycle.contributions.length}/{lifecycle.requiredParticipantIds.length} · 确认 {lifecycle.confirmations.length}/{lifecycle.requiredParticipantIds.length} · 实施回执 {lifecycle.reports.length}/{lifecycle.requiredParticipantIds.length}</div>
    {lifecycle.document && <div><h3>开发对接实施文档 · v{lifecycle.revision}</h3><pre className="message-text" style={{ whiteSpace: "pre-wrap", fontFamily: "inherit", maxHeight: 600, overflow: "auto" }}>{lifecycle.document}</pre><details className="small muted"><summary>文档内容指纹</summary>{lifecycle.documentHash}</details></div>}
    {data.canAdminister && lifecycle.phase === "awaiting_approval" && <button className="btn" disabled={busy} onClick={() => void run(path, { action: "approve", revision: lifecycle.revision, documentHash: lifecycle.documentHash }).catch(() => undefined)}>确认文档并执行</button>}
    {lifecycle.report && <div><h3>完整实施报告 · v{lifecycle.revision}</h3><pre className="message-text" style={{ whiteSpace: "pre-wrap", fontFamily: "inherit" }}>{lifecycle.report}</pre>{lifecycle.reports.some((report) => report.status === "failed") && <div className="notice error">本轮存在未通过项，请查看测试证据和未完成内容后决定下一步。</div>}</div>}
    {data.artifacts.filter((artifact) => artifact.type === "test-report").map((artifact) => <details key={artifact.id} open><summary>补充测试证据：{artifact.title}</summary><pre className="message-text" style={{ whiteSpace: "pre-wrap", fontFamily: "inherit" }}>{artifact.versions.find((version) => version.version === artifact.currentVersion)?.content}</pre></details>)}
    {data.canAdminister && ["awaiting_approval", "awaiting_review"].includes(lifecycle.phase) && <form className="stack" onSubmit={async (event) => {
      event.preventDefault(); const form = event.currentTarget;
      try { await run(path, { action: "append", requirements: new FormData(form).get("requirements") }); form.reset(); } catch {}
    }}><div className="field"><label>补充要求</label><textarea name="requirements" required placeholder="补充本轮需要调整的目标，双方 AI 会自动起草并确认下一轮文档。" /></div><button className="btn btn-secondary" disabled={busy}>补充要求并重新起草</button></form>}
    {data.canAdminister && lifecycle.phase === "awaiting_review" && <button className="btn" disabled={busy} onClick={() => void run(path, { action: "terminate", revision: lifecycle.revision }).catch(() => undefined)}>满意，确认终止任务</button>}
    {data.lifecycleHistory.filter((revision) => revision.revision !== lifecycle.revision).map((revision) => <details key={revision.revision}><summary>历史第 {revision.revision} 轮文档与报告</summary><h3>开发对接实施文档</h3><pre className="message-text" style={{ whiteSpace: "pre-wrap", fontFamily: "inherit" }}>{revision.document ?? "未形成完整文档"}</pre><h3>实施报告</h3><pre className="message-text" style={{ whiteSpace: "pre-wrap", fontFamily: "inherit" }}>{revision.report ?? "未进入实施"}</pre></details>)}
    <details><summary>本轮两端提交记录</summary>{lifecycle.contributions.map((entry) => <div className="list-item" key={entry.participantId}><strong>{data.participants.find((row) => row.participant.id === entry.participantId)?.project.name}</strong><span className="small muted"> · {lifecycle.confirmations.includes(entry.participantId) ? "已确认共同文档" : "已提交计划"}</span></div>)}</details>
  </section>;
}
