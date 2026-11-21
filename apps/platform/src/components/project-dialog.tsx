"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { apiRequest, errorMessage } from "@/lib/client-api";

export type ProjectDialogAction =
  | { kind: "create" }
  | { kind: "register"; project: { id: string; name: string } };

export function ProjectDialog({ action, onDismiss, onSaved }: {
  action: ProjectDialogAction;
  onDismiss: () => void;
  onSaved: (message: string) => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const configRef = useRef<HTMLTextAreaElement>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [config, setConfig] = useState("");
  const [copyStatus, setCopyStatus] = useState("");

  useEffect(() => {
    const dialog = dialogRef.current!;
    dialog.showModal();
    return () => dialog.close();
  }, []);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (saving) return;
    const fields = Object.fromEntries(new FormData(event.currentTarget));
    setSaving(true);
    setError("");
    try {
      if (action.kind === "create") {
        const { project } = await apiRequest("/api/projects", fields);
        onSaved(`已创建「${project.name}」。`);
        dialogRef.current?.close();
      } else {
        const { agent } = await apiRequest("/api/agents", { ...fields, projectId: action.project.id });
        setConfig([
          `SEAM_AGENT_ID=${agent.id}`,
          `SEAM_AGENT_TOKEN=${agent.token}`,
          `SEAM_PLATFORM_URL=${window.location.origin}`,
          "SEAM_PROJECT_ROOT=/path/to/private/project",
        ].join("\n"));
        onSaved(`已将「${agent.name}」注册到「${action.project.name}」。`);
      }
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  }

  async function copyConfig() {
    let copied = false;
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(config);
        copied = true;
      }
    } catch {
      // The browser may expose the Clipboard API but deny the write.
    }
    if (!copied) {
      const field = configRef.current;
      if (!field || !dialogRef.current?.open) return;
      field.focus();
      field.select();
      try {
        // On LAN HTTP, copy the selection inside the modal during this click.
        copied = document.execCommand("copy");
      } catch {
        // Leave the full configuration selected for manual copying.
      }
    }
    setCopyStatus(copied ? "配置已复制。" : "自动复制受限，配置已全选。请按 ⌘C 或 Ctrl+C 复制，手机可长按选择「复制」。");
  }

  const title = config ? "Connector 凭据" : action.kind === "create" ? "新建项目" : "注册 Agent";
  return <dialog className="project-dialog" ref={dialogRef} aria-labelledby="project-dialog-title"
    onCancel={(event) => { if (saving) event.preventDefault(); }}
    onClose={(event) => { if (!event.currentTarget.open) onDismiss(); }}>
    <h2 id="project-dialog-title">{title}</h2>
    {action.kind === "register" && <p className="dialog-project">所属项目 <strong>{action.project.name}</strong></p>}
    {config ? <div className="stack">
      <p className="credential-note">Agent Token 只显示这一次，请立即保存。</p>
      <div className="field" data-sensitive>
        <label htmlFor="connector-config">Connector 配置</label>
        <textarea ref={configRef} id="connector-config" className="code connector-config" rows={5} value={config} readOnly spellCheck={false} />
      </div>
      {copyStatus && <div className="small" role="status">{copyStatus}</div>}
      <div className="dialog-actions">
        <button type="button" className="btn btn-secondary" onClick={copyConfig}>复制配置</button>
        <button type="button" className="btn" autoFocus onClick={() => dialogRef.current?.close()}>已保存，关闭</button>
      </div>
    </div> : <form className="stack" onSubmit={submit}>
      {action.kind === "create" ? <>
        <div className="field"><label htmlFor="project-name">项目名称</label>
          <input id="project-name" name="name" required maxLength={200} placeholder="例如：订单前端" /></div>
        <div className="field"><label htmlFor="project-description">说明（选填）</label>
          <textarea id="project-description" name="description" maxLength={5000} placeholder="项目职责与对接范围" /></div>
      </> : <>
        <div className="field"><label htmlFor="agent-name">Agent 名称</label>
          <input id="agent-name" name="name" required maxLength={100} placeholder="backend-ai" /></div>
        <div className="field"><label htmlFor="agent-adapter">适配器</label>
          <select id="agent-adapter" name="adapter" defaultValue="codex-app-server">
            <option value="codex-app-server">Codex 持久对话（推荐）</option><option value="claude-code">Claude Code</option>
            <option value="codex">Codex CLI</option><option value="generic-cli">通用 CLI</option><option value="mock">Mock（联调测试）</option>
          </select></div>
        <p className="small muted connector-hint">每个 Agent 通过本地 Connector 接入，平台不读取项目源码。</p>
      </>}
      {error && <div className="notice error" role="alert">{error}</div>}
      <div className="dialog-actions">
        <button type="button" className="btn btn-secondary" disabled={saving} onClick={() => dialogRef.current?.close()}>取消</button>
        <button type="submit" className="btn" disabled={saving}>{saving ? "正在提交…" : action.kind === "create" ? "创建项目" : "生成 Connector 凭据"}</button>
      </div>
    </form>}
  </dialog>;
}
