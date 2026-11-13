import type { LifecycleContext } from "@seam/protocol";

export function InformationPanel({ lifecycle, name }: { lifecycle: LifecycleContext; name: (id: string) => string }) {
  const requests = [...new Map([...(lifecycle.baseline?.informationRequests ?? []), ...(lifecycle.informationRequests ?? [])].map(row => [row.id, row])).values()];
  if (!requests.length) return null;
  const pending = requests.filter(row => row.status === "pending").length;
  return <details aria-label="缺失信息自动获取" open={pending > 0}><summary>缺失信息自动获取 · {pending > 0 ? `${pending}项进行中` : "查看来源与答复"}</summary>
    <p className="small muted">先查本地项目与共享资料，再自动询问对端；仍无法获得时才请管理员补充事实。信息查找为只读，不重新实施或运行验证。</p>
    {requests.map(request => <details key={request.id}><summary>第{request.revision}轮 · {name(request.requestedByParticipantId)}：{request.question} · {request.status === "answered" ? "已获取" : request.status === "needs_admin" ? "查找后仍缺失" : request.stage === "local" ? "查本地与共享资料" : "向对端询证"}</summary>
      {request.answer && <p style={{ whiteSpace: "pre-wrap" }}>{request.answer}</p>}
      {request.administratorResolution && <p className="small muted">管理员补充事实 · {request.administratorResolution.providedAt}</p>}
      {request.responses.map((response, index) => <div className="list-item" key={index}><strong>{name(response.participantId)} · {response.mode === "local" ? "本地与共享检索" : "对端答复"} · {response.status === "found" ? "找到事实" : "未找到"}</strong><p style={{ whiteSpace: "pre-wrap" }}>{response.answer}</p>{response.sources.map((source, i) => <p className="small muted" key={i}>{source.scope === "local_project" ? "项目资料" : source.scope === "shared_context" ? "共享资料" : "运行状态"} · {source.reference}：{source.finding}</p>)}</div>)}
    </details>)}
  </details>;
}
