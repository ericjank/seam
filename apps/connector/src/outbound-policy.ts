import type { AgentTurnResult } from "@seam/protocol";

const forbiddenPatterns = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/i,
  /(?:DATABASE_URL|DB_PASSWORD|SECRET_ACCESS_KEY)\s*=/i,
  /(?:mysql|postgres(?:ql)?):\/\/[^\s/]+:[^\s/]+@/i,
];

export function assertOutboundPolicy(result: AgentTurnResult, projectRoot: string) {
  if (forbiddenPatterns.some((pattern) => pattern.test(result.message))) {
    throw new Error("本地出站策略阻止了疑似系统密钥的消息；联调凭据请使用专用授权流程");
  }
  if (projectRoot && result.message.includes(projectRoot)) {
    throw new Error("本地出站策略阻止了包含项目绝对路径的消息");
  }
  return result;
}
