"use client";

import { useAction } from "./use-action";

type Member = { id: string; name: string; email: string; role: string; createdAt: string | Date };

export function OrganizationManager({ organizationName, currentRole, members }: {
  organizationName: string;
  currentRole: string;
  members: Member[];
}) {
  const { run, error, busy } = useAction();
  return <div className="stack">
    <div className="page-header"><div><h1>{organizationName}</h1><p className="muted">组织成员和访问角色。项目之间仍需通过协作邀请显式连接。</p></div></div>
    {error && <div className="notice error">{error}</div>}
    {currentRole === "owner" && <section className="card"><h2>邀请成员</h2>
      <form className="form-grid" onSubmit={async (event) => {
        event.preventDefault();
        const form = event.currentTarget;
        try { await run("/api/users", Object.fromEntries(new FormData(form))); form.reset(); } catch {}
      }}>
        <div className="field"><label>姓名</label><input name="name" required /></div>
        <div className="field"><label>邮箱</label><input name="email" type="email" required /></div>
        <div className="field"><label>临时密码（至少 12 位）</label><input name="password" type="password" minLength={12} autoComplete="new-password" required /></div>
        <div className="field"><label>角色</label><select name="role"><option value="member">成员（可创建和修改）</option><option value="viewer">只读成员</option></select></div>
        <div className="wide"><button className="btn" disabled={busy}>创建受邀账号</button></div>
      </form>
    </section>}
    <section className="card"><h2>成员列表</h2><table className="table"><thead><tr><th>姓名</th><th>邮箱</th><th>角色</th><th>加入时间</th></tr></thead><tbody>
      {members.map((member) => <tr key={member.id}><td>{member.name}</td><td>{member.email}</td><td><span className="badge">{member.role}</span></td><td>{new Date(member.createdAt).toLocaleString("zh-CN")}</td></tr>)}
    </tbody></table></section>
  </div>;
}
