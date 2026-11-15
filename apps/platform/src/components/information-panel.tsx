import type { LifecycleContext } from "@seam/protocol";
import { formatDateTime } from "@/lib/date-time";

export function InformationPanel({ lifecycle, name, onRetry, onResolve, busy }: { lifecycle: LifecycleContext; name: (id: string) => string; onRetry?: (id: string) => void; onResolve?: (id: string, answer: string) => Promise<unknown>; busy?: boolean }) {
  const requests = [...new Map([...(lifecycle.baseline?.informationRequests ?? []), ...(lifecycle.informationRequests ?? [])].map(row => [row.id, row])).values()];
  if (!requests.length && !lifecycle.facts.length) return null;
  const pending = requests.filter(row => ["pending", "conflicted"].includes(row.status)).length;
  return <details aria-label="缺失信息自动获取" open={pending > 0 || requests.some(row => row.status === "needs_admin")}><summary>缺失信息自动获取 · {pending > 0 ? `${pending}项进行中` : "查看来源与答复"}</summary>
    <p className="small muted">先查本地项目与共享资料，再自动询问对端；仍无法获得时才请管理员补充事实。信息查找为只读，不重新实施或运行验证。</p>
    {requests.map(request => <details key={request.id} open={request.status === "needs_admin" || request.status === "conflicted"}><summary>第{request.revision}轮 · {name(request.requestedByParticipantId)}：{request.question} · {request.status === "answered" ? "已获取" : request.status === "needs_admin" ? "查找后仍缺失或冲突" : request.status === "conflicted" ? "答复冲突，双方继续核对" : request.stage === "verify" ? "复核已知事实来源" : request.stage === "local" ? "查本地与共享资料" : "向对端询证"}</summary>
      {request.deadlineAt && <p className="small muted">查找轮次 {request.attempt ?? 1} · 截止 {formatDateTime(request.deadlineAt)}{request.retryAt ? ` · 退避至 ${formatDateTime(request.retryAt)}` : ""}</p>}
      {request.failureReason && <p>{request.failureReason}</p>}
      {request.answer && <p style={{ whiteSpace: "pre-wrap" }}>{request.answer}</p>}
      {request.administratorResolution && <p className="small muted">管理员补充事实 · {request.administratorResolution.providedAt}</p>}
      {request.responses.map((response, index) => <div className="list-item" key={index}><strong>{name(response.participantId)} · {response.mode === "local" ? "本地与共享检索" : "对端答复"} · {response.status === "found" ? "找到事实" : "未找到"} · 第{response.attempt ?? 1}次</strong><p style={{ whiteSpace: "pre-wrap" }}>{response.answer}</p>{response.value && <p>规范值：{response.value}</p>}{response.sources.map((source, i) => <p className="small muted" key={i}>{source.scope === "local_project" ? "项目资料" : source.scope === "shared_context" ? "共享资料" : "运行状态"} · {source.reference}：{source.finding}{source.sourceVersion && ` · 版本 ${source.sourceVersion}`}{source.contentHash && ` · SHA-256 ${source.contentHash}`}</p>)}</div>)}
      {request.revision === lifecycle.revision && request.status === "needs_admin" && onRetry && <button className="btn btn-secondary" disabled={busy} onClick={() => onRetry(request.id)}>对端恢复后重新查找</button>}
      {request.revision === lifecycle.revision && request.status === "needs_admin" && onResolve && <form className="stack" onSubmit={async event => { event.preventDefault(); const form = event.currentTarget; try { await onResolve(request.id, String(new FormData(form).get("resolution"))); form.reset(); } catch {} }}><label>补充此问题的必要事实<textarea name="resolution" required maxLength={5000} placeholder="仅回答当前问题；补事实不增加本机权限，也不代替失败后的重试确认。" /></label><button className="btn" disabled={busy}>保存事实并继续</button></form>}
    </details>)}
    {!!lifecycle.facts.length && <details aria-label="跨修订共享事实"><summary>跨修订共享事实（{lifecycle.facts.length}项）</summary>{lifecycle.facts.map(fact => <div className="list-item" key={fact.key}><strong>{fact.question} · {fact.status === "active" ? "有效，使用前核对来源" : fact.status === "stale" ? "已失效，需重新核对" : fact.status === "unverified" ? "本修订待自动核验" : "存在冲突"}</strong><p>{fact.value}</p><p className="small muted">{fact.authority === "administrator" ? "管理员补充" : "项目资料核对"} · 修订{fact.revision} · 有效至{formatDateTime(fact.validUntil)} · {fact.key}</p></div>)}</details>}
  </details>;
}
