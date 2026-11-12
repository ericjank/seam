import { resolve } from "node:path";
import type { AdapterType, CodexSandbox } from "@seam/agent-adapters";

export interface ConnectorConfig {
  platformUrl: string;
  agentId: string;
  token: string;
  projectRoot: string;
  adapter: AdapterType;
  once: boolean;
  pollMs: number;
  codexSandbox?: CodexSandbox;
  doctor?: boolean;
  appServerStateDir?: string;
  codexNetworkAccess?: boolean;
  stateDir?: string;
  workspaceLockDir?: string;
}

export function readConfig(args: string[], env = process.env): ConnectorConfig {
  const flags = new Map<string, string>();
  const booleanFlags = new Set(["once", "doctor", "help"]);
  const valueFlags = new Set(["platform", "agent-id", "token", "project-root", "adapter", "codex-sandbox", "app-server-state-dir", "codex-network-access", "connector-state-dir", "workspace-lock-dir"]);
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg?.startsWith("--")) throw new Error(`无法识别的参数 ${arg}`);
    const name = arg.slice(2);
    if (booleanFlags.has(name)) continue;
    if (!valueFlags.has(name)) throw new Error(`无法识别的选项 --${name}`);
    const value = args[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`选项 --${name} 缺少值`);
    flags.set(name, value);
    index += 1;
  }
  const doctor = args.includes("--doctor");
  const required = (name: string, flag: string) => {
    const value = flags.get(flag) ?? env[name];
    if (!value && !doctor) throw new Error(`缺少配置 ${name} 或 --${flag}`);
    if (!value) return "";
    return value;
  };
  const adapter = flags.get("adapter") ?? env.SEAM_ADAPTER ?? "mock";
  if (!["claude-code", "codex", "codex-app-server", "generic-cli", "mock"].includes(adapter)) throw new Error("SEAM_ADAPTER 必须为 claude-code、codex、codex-app-server、generic-cli 或 mock");
  const codexSandbox = flags.get("codex-sandbox") ?? env.SEAM_CODEX_SANDBOX ?? "read-only";
  if (codexSandbox !== "read-only" && codexSandbox !== "workspace-write") throw new Error("SEAM_CODEX_SANDBOX 仅允许 read-only 或 workspace-write");
  const network = flags.get("codex-network-access") ?? env.SEAM_CODEX_NETWORK_ACCESS ?? "false";
  if (network !== "true" && network !== "false") throw new Error("SEAM_CODEX_NETWORK_ACCESS 仅允许 true 或 false");
  const pollMs = Number(env.SEAM_POLL_INTERVAL_MS ?? 1000);
  if (!Number.isFinite(pollMs) || pollMs < 100) throw new Error("SEAM_POLL_INTERVAL_MS 必须是至少 100 的有限毫秒数");
  return {
    platformUrl: (flags.get("platform") ?? env.SEAM_PLATFORM_URL ?? "http://localhost:3000").replace(/\/$/, ""),
    agentId: required("SEAM_AGENT_ID", "agent-id"),
    token: required("SEAM_AGENT_TOKEN", "token"),
    projectRoot: resolve(flags.get("project-root") ?? env.SEAM_PROJECT_ROOT ?? process.cwd()),
    adapter: adapter as AdapterType,
    once: args.includes("--once"),
    pollMs,
    codexSandbox,
    doctor,
    appServerStateDir: flags.get("app-server-state-dir") ?? env.SEAM_APP_SERVER_STATE_DIR,
    codexNetworkAccess: network === "true",
    stateDir: flags.get("connector-state-dir") ?? env.SEAM_CONNECTOR_STATE_DIR,
    workspaceLockDir: flags.get("workspace-lock-dir") ?? env.SEAM_WORKSPACE_LOCK_DIR,
  };
}
