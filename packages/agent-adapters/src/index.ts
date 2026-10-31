import type { AgentAdapter, AdapterType, AgentRunInput } from "./types";
import { checkCli, executeCli } from "./cli";
import { MockAgentAdapter } from "./mock";

class CliAgentAdapter implements AgentAdapter {
  constructor(readonly type: Exclude<AdapterType, "mock">) {}

  async run(input: AgentRunInput) {
    if (this.type === "claude-code") {
      return executeCli(input, process.env.SEAM_CLAUDE_COMMAND ?? "claude", ["-p", "--output-format", "json"]);
    }
    if (this.type === "codex") {
      return executeCli(input, process.env.SEAM_CODEX_COMMAND ?? "codex", ["exec", "--json"]);
    }
    const command = process.env.SEAM_GENERIC_AGENT_COMMAND;
    if (!command) throw new Error("未配置 SEAM_GENERIC_AGENT_COMMAND");
    const args = JSON.parse(process.env.SEAM_GENERIC_AGENT_ARGS ?? "[]") as string[];
    return executeCli(input, command, args);
  }

  async healthCheck(projectRoot: string) {
    if (this.type === "generic-cli") {
      const command = process.env.SEAM_GENERIC_AGENT_COMMAND;
      if (!command) return { ok: false, detail: "未配置 SEAM_GENERIC_AGENT_COMMAND" };
      return checkCli(command, ["--version"], projectRoot);
    }
    return checkCli(this.type === "claude-code" ? "claude" : "codex", ["--version"], projectRoot);
  }
}

export function createAgentAdapter(type: AdapterType): AgentAdapter {
  return type === "mock" ? new MockAgentAdapter() : new CliAgentAdapter(type);
}

export { buildPrompt, parseAgentOutput } from "./cli";
export { MockAgentAdapter } from "./mock";
export type { AgentAdapter, AdapterType, AgentRunInput } from "./types";
