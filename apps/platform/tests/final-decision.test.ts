import { describe,expect,it } from "vitest";
import { createHash,randomUUID } from "node:crypto";
import { sealFinalDecision } from "../src/lib/final-decision";
const report="原始失败与通过明细，不可因终止而覆盖。";
const sha=(value:string)=>createHash("sha256").update(value).digest("hex");
const input=()=>({revision:2,documentHash:"a".repeat(64),report,reviewedHash:sha(report),outcome:"accepted" as const,userId:randomUUID(),canAccept:true,at:"2026-11-15T16:00:00.000Z"});
describe("管理员最终决定",()=>{
 it("满意决定绑定实际审阅报告和封存报告，原始证据保持前缀不变",()=>{const value=sealFinalDecision(input());expect(value.report.startsWith(report)).toBe(true);expect(value.decision.reviewedReportHash).toBe(sha(report));expect(value.decision.sealedReportHash).toBe(sha(value.report));expect(value.report).toContain("验收通过，满意并确认终止");});
 it("报告变化或尚未全部通过时拒绝满意验收",()=>{expect(()=>sealFinalDecision({...input(),reviewedHash:"b".repeat(64)})).toThrow("报告已变化");expect(()=>sealFinalDecision({...input(),canAccept:false})).toThrow("均通过");});
 it("停止失败任务有独立结论，不能被解释为满意验收",()=>{const value=sealFinalDecision({...input(),canAccept:false,outcome:"stopped"});expect(value.decision.outcome).toBe("stopped");expect(value.report).toContain("未确认满意验收");expect(value.report.startsWith(report)).toBe(true);});
});
