"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { apiRequest, errorMessage } from "@/lib/client-api";

export function AuthForm({ setup }: { setup: boolean }) {
  const router = useRouter();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  return <div className="auth-page"><div className="auth-card">
    <div className="auth-logo">Seam<span style={{ color: "var(--brand)" }}>·</span></div>
    <h1>{setup ? "初始化协作平台" : "欢迎回来"}</h1>
    <p className="muted">{setup ? "创建首个组织与所有者账号。平台仅接受后续受邀项目。" : "登录后继续管理项目协作。"}</p>
    <form className="stack" onSubmit={async (event) => {
      event.preventDefault();
      setBusy(true); setError("");
      const form = new FormData(event.currentTarget);
      try {
        await apiRequest(setup ? "/api/setup" : "/api/auth/login", Object.fromEntries(form));
        router.replace("/collaborations");
      } catch (err) { setError(errorMessage(err)); } finally { setBusy(false); }
    }}>
      {setup && <>
        <div className="field"><label htmlFor="organizationName">组织名称</label><input id="organizationName" name="organizationName" required /></div>
        <div className="field"><label htmlFor="name">你的姓名</label><input id="name" name="name" required /></div>
      </>}
      <div className="field"><label htmlFor="email">邮箱</label><input id="email" name="email" type="email" autoComplete="email" required /></div>
      <div className="field"><label htmlFor="password">密码{setup && "（至少 12 位）"}</label><input id="password" name="password" type="password" autoComplete={setup ? "new-password" : "current-password"} minLength={setup ? 12 : 1} required /></div>
      {error && <div className="notice error">{error}</div>}
      <button className="btn" disabled={busy}>{busy ? "请稍候…" : setup ? "创建并进入" : "登录"}</button>
    </form>
    {!setup && <p className="small muted">私有部署不提供公开注册，请联系组织所有者创建账号。</p>}
  </div></div>;
}
