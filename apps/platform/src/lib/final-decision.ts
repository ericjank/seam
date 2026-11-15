import { createHash } from "node:crypto";
import type { LifecycleContext } from "@seam/protocol";
import { HttpError } from "./http";

export function sealFinalDecision(input: { revision: number; documentHash: string | null; report: string | null; reviewedHash: string | null; outcome: "accepted" | "stopped"; userId: string; canAccept: boolean; at?: string }) {
  const digest = (text: string) => createHash("sha256").update(text).digest("hex");
  if ((input.report ? digest(input.report) : null) !== input.reviewedHash) throw new HttpError(409, "报告已变化，请阅读当前报告后再确认最终决定");
  if (input.outcome === "accepted" && !input.canAccept) throw new HttpError(409, "只有完整实施和联合验证均通过的报告才能确认满意验收；仍可选择停止任务并保留未通过结果");
  const at = input.at ?? new Date().toISOString();
  const report = `${input.report ?? "本版尚无实施报告，没有重新实施或验证，未确认验收通过。"}\n\n---\n\n## 管理员最终决定\n\n结论：${input.outcome === "accepted" ? "验收通过，满意并确认终止" : "停止任务，未确认满意验收"}\n修订：${input.revision}\n审阅报告SHA-256：${input.reviewedHash ?? "无实施报告"}\n开发文档SHA-256：${input.documentHash ?? "未批准"}\n管理员：${input.userId}\n确认时间：${at}\n\n原始测试、失败及未执行结果保留；最终决定不改写实际测试结果。`;
  const decision: NonNullable<LifecycleContext["finalDecision"]> = { outcome: input.outcome, revision: input.revision, reviewedReportHash: input.reviewedHash, sealedReportHash: digest(report), documentHash: input.documentHash, decidedById: input.userId, decidedAt: at };
  return { report, decision };
}
