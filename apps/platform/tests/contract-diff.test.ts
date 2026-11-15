import { describe, expect, it } from "vitest";
import { contractChanges } from "../src/lib/contract-diff";
import { fixtureContract } from "./fixtures/shared-contract";

describe("管理员内容差异", () => {
  it("同ID的独立验收期望和测试变更授权必须显示实际差异",()=>{
    const before=fixtureContract([crypto.randomUUID(),crypto.randomUUID()],1),after=structuredClone(before);
    const check={id:"amount",publisherParticipantId:before.impactedParticipantIds[0]!,serviceName:"quote",method:"POST" as const,path:"/quote",requestBody:null,expectedStatus:200,bodyChecks:[{path:"subtotal",equals:24000}]};
    before.acceptanceCases[0]!.httpChecks=[check];after.acceptanceCases[0]!.httpChecks=[{...check,bodyChecks:[{path:"subtotal",equals:24001}]}];
    after.testChanges=[{participantId:before.impactedParticipantIds[0]!,path:"joint.test.mjs",reason:"管理员需要明确审阅此测试变化"}];
    const diff=contractChanges(before,after);expect(diff).toHaveLength(2);expect(diff.find(row=>row.key.startsWith("独立HTTP"))!.before).toContain("24000");expect(diff.find(row=>row.key==="测试文件变更授权")!.after).toContain("joint.test.mjs");
  });
  it("同ID语义修改、删除和新增显示实际前后内容，未变项目不占据审阅视图", () => {
    const before = fixtureContract([crypto.randomUUID(), crypto.randomUUID()], 1);
    const after = structuredClone(before);
    after.interfaces[0]!.definition += " discountPercent的null必须拒绝。";
    after.acceptanceCases.shift();
    after.interfaces.push({ id: "health", definition: "GET /health returns readiness and revision" });
    const changes = contractChanges(before, after);
    expect(changes.find((item) => item.key === "接口 quote")).toEqual({ key: "接口 quote", before: before.interfaces[0]!.definition, after: after.interfaces[0]!.definition });
    expect(changes.find((item) => item.key === "接口 health")!.before).toBe("（无）");
    expect(changes.find((item) => item.key === "用例 joint-1")!.after).toBe("（已移除）");
    expect(changes.some((item) => item.key === "范围")).toBe(false);
    expect(contractChanges(after, structuredClone(after))).toEqual([]);
  });
});
