import type { AgentAdapter, AdapterOptions, AdapterType, AgentRunInput } from "./types.js";
import { checkCli, executeCli } from "./cli.js";
import { MockAgentAdapter } from "./mock.js";
import { CodexAppServerAdapter } from "./app-server.js";
import { codexNetworkForTurn, codexSandboxForTurn } from "./policy.js";

class CliAgentAdapter implements AgentAdapter {
  constructor(readonly type: Exclude<AdapterType, "mock" | "codex-app-server">, private options: AdapterOptions) {}

  async run(input: AgentRunInput) {
    const sandbox = codexSandboxForTurn(input, this.options);
    input = { ...input, conversationMode: "independent", localExecutionPolicy: describeExecutionPolicy(this.type, { ...this.options, codexSandbox: sandbox }) };
    if (this.type === "claude-code") {
      return executeCli(input, process.env.SEAM_CLAUDE_COMMAND ?? "claude", ["-p", "--output-format", "json"]);
    }
    if (this.type === "codex") {
      return executeCli(input, process.env.SEAM_CODEX_COMMAND ?? "codex", [
        "exec", "--json", "--sandbox", sandbox,
        "--config", 'approval_policy="never"', "--config", `sandbox_workspace_write.network_access=${codexNetworkForTurn(input, this.options)}`, "--cd", input.projectRoot, "--",
      ]);
    }
    const command = process.env.SEAM_GENERIC_AGENT_COMMAND;
    if (!command) throw new Error("未配置 SEAM_GENERIC_AGENT_COMMAND");
    const args: unknown = JSON.parse(process.env.SEAM_GENERIC_AGENT_ARGS ?? "[]");
    if (!Array.isArray(args) || args.some((arg) => typeof arg !== "string")) {
      throw new Error("SEAM_GENERIC_AGENT_ARGS 必须是字符串数组");
    }
    return executeCli(input, command, args);
  }

  async healthCheck(projectRoot: string) {
    if (this.type === "generic-cli") {
      const command = process.env.SEAM_GENERIC_AGENT_COMMAND;
      if (!command) return { ok: false, detail: "未配置 SEAM_GENERIC_AGENT_COMMAND" };
      return checkCli(command, ["--version"], projectRoot);
    }
    const command = this.type === "claude-code" ? process.env.SEAM_CLAUDE_COMMAND ?? "claude" : process.env.SEAM_CODEX_COMMAND ?? "codex";
    return checkCli(command, ["--version"], projectRoot);
  }
}

export function describeExecutionPolicy(type: AdapterType, options: AdapterOptions = {}) {
  if (type === "mock") return "Mock：只产生模拟协议结果，不执行本地代码或测试。";
  if (type !== "codex" && type !== "codex-app-server") return "外部 CLI：有效写入、审批和网络权限由本机 CLI 配置决定；Seam 未验证其权限，不能把健康检查当作写入或测试能力证明。";
  const sandbox = options.codexSandbox ?? "read-only";
  if (sandbox !== "read-only" && sandbox !== "workspace-write") throw new Error("Codex 仅支持 read-only 或 workspace-write 本地策略");
  return `Codex sandbox=${sandbox}，approval=never；${sandbox === "workspace-write" ? "本地写入能力已配置，仅 executing 且已批准同一方案 hash 的轮次允许在本地项目沙箱内实施并测试" : "只读，不可宣称已落盘修改"}。网络本地配置=${options.codexNetworkAccess === true}，只在批准的 executing 生效。受限操作须报告阻塞，由本地维护者处理；平台消息不能提升权限。`;
}

export function createAgentAdapter(type: AdapterType, options: AdapterOptions = {}): AgentAdapter {
  describeExecutionPolicy(type, options);
  if (type === "codex-app-server") return new CodexAppServerAdapter({ ...options });
  return type === "mock" ? new MockAgentAdapter() : new CliAgentAdapter(type, { ...options });
}

export { buildPrompt, parseAgentOutput } from "./cli.js";
export { MockAgentAdapter } from "./mock.js";
export { CodexAppServerAdapter } from "./app-server.js";
export { codexNetworkForTurn, codexSandboxForTurn } from "./policy.js";
export type { AgentAdapter, AdapterOptions, AdapterType, AgentRunInput, CodexSandbox } from "./types.js";
