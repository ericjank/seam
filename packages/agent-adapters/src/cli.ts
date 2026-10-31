import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { agentTurnResultSchema, type AgentTurnResult } from "@seam/protocol";
import type { AgentRunInput } from "./types";

const execFileAsync = promisify(execFile);

export async function executeCli(input: AgentRunInput, command: string, args: string[]) {
  const prompt = buildPrompt(input);
  const { stdout, stderr } = await execFileAsync(command, [...args, prompt], {
    cwd: input.projectRoot,
    timeout: 15 * 60 * 1000,
    maxBuffer: 10 * 1024 * 1024,
    signal: input.signal,
    env: { ...process.env, SEAM_COLLABORATION_MODE: "1" },
  });
  return parseAgentOutput(stdout || stderr);
}

export function buildPrompt(input: AgentRunInput) {
  if (!input.context) return input.prompt ?? "";
  return [
    "你是 Seam 多方项目协作中的一个项目 Agent。你只代表 context.participant 指定的项目。",
    "源码、未声明文件和本地环境变量不得发布。只讨论协作所需的信息。",
    "你必须只返回一个符合以下结构的 JSON 对象，不要使用 Markdown 代码围栏：",
    '{"message":"给协作各方的消息","kind":"chat|question|clarification|objection|status","actions":[],"notifyParticipantIds":[],"needsHumanInput":false}',
    "actions 支持 artifact.upsert、proposal.create、proposal.decide、work.create、work.update、credential.request、acceptance.submit。",
    "不要虚构参与方、任务或产物 ID；只能使用 context 中已有 ID。只有需要其他 Agent 继续对话时才填写 notifyParticipantIds。",
    "验收必须来自真实测试；没有运行测试就不能提交 acceptance.submit。",
    `协作上下文：${JSON.stringify(input.context)}`,
  ].join("\n\n");
}

export function parseAgentOutput(raw: string): AgentTurnResult {
  const direct = tryJson(raw);
  const resultCandidate = direct && typeof direct === "object" && "result" in direct
    ? (direct as { result: unknown }).result
    : direct;
  if (typeof resultCandidate === "string") {
    const nested = tryJson(resultCandidate);
    if (nested) return agentTurnResultSchema.parse(nested);
    return { message: resultCandidate, kind: "chat", actions: [], notifyParticipantIds: [], needsHumanInput: false };
  }
  if (resultCandidate) return agentTurnResultSchema.parse(resultCandidate);

  const jsonlMessages = raw.split("\n").flatMap((line) => {
    const value = tryJson(line);
    if (!value || typeof value !== "object") return [];
    const record = value as Record<string, unknown>;
    const text = record.agent_message ?? record.message ?? record.text;
    return typeof text === "string" ? [text] : [];
  });
  const text = jsonlMessages.at(-1) ?? raw.trim();
  const nested = tryJson(text);
  if (nested) return agentTurnResultSchema.parse(nested);
  if (!text) throw new Error("AI CLI 未返回内容");
  return { message: text, kind: "chat", actions: [], notifyParticipantIds: [], needsHumanInput: false };
}

function tryJson(value: string): unknown {
  try { return JSON.parse(value); } catch { return undefined; }
}

export async function checkCli(command: string, args: string[] = ["--version"], cwd: string) {
  try {
    const { stdout, stderr } = await execFileAsync(command, args, { cwd, timeout: 10_000 });
    return { ok: true, detail: (stdout || stderr).trim().split("\n")[0] || "可用" };
  } catch (error) {
    return { ok: false, detail: error instanceof Error ? error.message : "CLI 不可用" };
  }
}
