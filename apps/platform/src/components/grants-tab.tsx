"use client";

import { useAction } from "./use-action";
import type { CollaborationData } from "./detail-types";

export function GrantsTab({ data }: { data: CollaborationData }) {
  const { run, error, busy } = useAction();
  const id = data.collaboration.id;
  return <div className="stack">
    <div className="notice">仅用于接口联调的 Token、测试账号等凭据。明文加密保存、只写不读，由接收方 Connector 一次性领取；不会出现在对话和审计内容中。</div>
    {error && <div className="notice error">{error}</div>}
    <section className="card"><h2>申请联调凭据</h2>
      <form className="form-grid" onSubmit={async (event) => {
        event.preventDefault();
        const form = event.currentTarget;
        const raw = Object.fromEntries(new FormData(form));
        if (!raw.expiresAt) delete raw.expiresAt;
        try { await run(`/api/collaborations/${id}/credentials`, raw); form.reset(); } catch {}
      }}>
        <div className="field"><label>名称</label><input name="name" required placeholder="订单测试环境 API Token" /></div>
        <div className="field"><label>类型</label><select name="type"><option value="api-token">API Token</option><option value="test-account">测试账号</option><option value="webhook-secret">Webhook Secret</option><option value="oauth-client">OAuth Client</option></select></div>
        <div className="field"><label>提供方</label><select name="ownerParticipantId">{data.participants.map((row) => <option key={row.participant.id} value={row.participant.id}>{row.project.name}</option>)}</select></div>
        <div className="field"><label>接收方</label><select name="recipientParticipantId">{data.participants.map((row) => <option key={row.participant.id} value={row.participant.id}>{row.project.name}</option>)}</select></div>
        <div className="field"><label>环境</label><input name="environment" defaultValue="test" required /></div>
        <div className="field"><label>到期时间（可选）</label><input name="expiresAt" type="datetime-local" /></div>
        <div className="field wide"><label>用途</label><textarea name="purpose" required placeholder="仅用于调用订单服务测试环境的契约测试" /></div>
        <div className="wide"><button className="btn" disabled={busy}>提交申请</button></div>
      </form>
    </section>
    {data.credentials.map((credential) => <section className="card" key={credential.id}>
      <div className="card-header"><div><h2>{credential.name}</h2><span className="small muted">{credential.type} · {credential.environment} · {credential.id}</span></div><span className={`badge ${["approved", "granted"].includes(credential.status) ? "badge-green" : credential.status === "revoked" ? "badge-red" : "badge-amber"}`}>{credential.status}</span></div>
      <p className="muted">{credential.purpose}</p>
      <p className="small muted">提供方：{data.participants.find((row) => row.participant.id === credential.ownerParticipantId)?.project.name} · 接收方：{data.participants.find((row) => row.participant.id === credential.recipientParticipantId)?.project.name}</p>
      {credential.expiresAt && <p className="small muted">到期：{new Date(credential.expiresAt).toLocaleString("zh-CN")}</p>}
      <div className="row">
        {["requested", "offered"].includes(credential.status) && <form className="row" onSubmit={async (event) => {
          event.preventDefault();
          const form = event.currentTarget;
          try { await run(`/api/credentials/${credential.id}`, { operation: "offer", secret: new FormData(form).get("secret") }); form.reset(); } catch {}
        }}><input name="secret" type="password" autoComplete="off" required placeholder="提交新凭据明文" /><button className="btn btn-secondary btn-small">加密提交</button></form>}
        {credential.status === "offered" && <button className="btn btn-small" onClick={() => void run(`/api/credentials/${credential.id}`, { operation: "approve" }).catch(() => undefined)}>批准一次性领取</button>}
        {!["revoked", "expired"].includes(credential.status) && <button className="btn btn-danger btn-small" onClick={() => void run(`/api/credentials/${credential.id}`, { operation: "revoke" }).catch(() => undefined)}>撤销</button>}
      </div>
    </section>)}
    {!data.credentials.length && <div className="empty">当前没有凭据申请。</div>}
  </div>;
}
