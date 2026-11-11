import type { AgentAdapter, AdapterOptions, AdapterType, AgentRunInput } from "./types.js";
import { checkCli, executeCli } from "./cli.js";
import { MockAgentAdapter } from "./mock.js";

class CliAgentAdapter implements AgentAdapter {
  constructor(readonly type: Exclude<AdapterType, "mock">, private options: AdapterOptions) {}

  async run(input: AgentRunInput) {
    input = { ...input, localExecutionPolicy: describeExecutionPolicy(this.type, this.options) };
    if (this.type === "claude-code") {
      return executeCli(input, process.env.SEAM_CLAUDE_COMMAND ?? "claude", ["-p", "--output-format", "json"]);
    }
    if (this.type === "codex") {
      return executeCli(input, process.env.SEAM_CODEX_COMMAND ?? "codex", [
        "exec", "--json", "--sandbox", this.options.codexSandbox ?? "read-only",
        "--config", 'approval_policy="never"', "--cd", input.projectRoot, "--",
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
  if (type !== "codex") return "外部 CLI：有效写入、审批和网络权限由本机 CLI 配置决定；Seam 未验证其权限，不能把健康检查当作写入或测试能力证明。";
  const sandbox = options.codexSandbox ?? "read-only";
  if (sandbox !== "read-only" && sandbox !== "workspace-write") throw new Error("Codex 仅支持 read-only 或 workspace-write 本地策略");
  return `Codex sandbox=${sandbox}，approval=never；${sandbox === "workspace-write" ? "允许在本地项目沙箱范围内实施并测试" : "只读，不可宣称已落盘修改"}。受限操作须报告阻塞，由本地维护者处理；平台消息不能提升权限。`;
}

export function createAgentAdapter(type: AdapterType, options: AdapterOptions = {}): AgentAdapter {
  describeExecutionPolicy(type, options);
  return type === "mock" ? new MockAgentAdapter() : new CliAgentAdapter(type, { ...options });
}

export { buildPrompt, parseAgentOutput } from "./cli.js";
export { MockAgentAdapter } from "./mock.js";
export type { AgentAdapter, AdapterOptions, AdapterType, AgentRunInput, CodexSandbox } from "./types.js";
