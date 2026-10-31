import { resolve } from "node:path";
import type { AdapterType } from "@seam/agent-adapters";

export interface ConnectorConfig {
  platformUrl: string;
  agentId: string;
  token: string;
  projectRoot: string;
  adapter: AdapterType;
  once: boolean;
  pollMs: number;
}

export function readConfig(args: string[], env = process.env): ConnectorConfig {
  const flags = new Map<string, string>();
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg?.startsWith("--") && args[index + 1]) flags.set(arg.slice(2), args[index + 1] as string);
  }
  const required = (name: string, flag: string) => {
    const value = flags.get(flag) ?? env[name];
    if (!value) throw new Error(`缺少配置 ${name} 或 --${flag}`);
    return value;
  };
  return {
    platformUrl: (flags.get("platform") ?? env.SEAM_PLATFORM_URL ?? "http://localhost:3000").replace(/\/$/, ""),
    agentId: required("SEAM_AGENT_ID", "agent-id"),
    token: required("SEAM_AGENT_TOKEN", "token"),
    projectRoot: resolve(flags.get("project-root") ?? env.SEAM_PROJECT_ROOT ?? process.cwd()),
    adapter: (flags.get("adapter") ?? env.SEAM_ADAPTER ?? "mock") as AdapterType,
    once: args.includes("--once"),
    pollMs: Number(env.SEAM_POLL_INTERVAL_MS ?? 1000),
  };
}
