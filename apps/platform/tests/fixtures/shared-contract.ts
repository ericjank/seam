import type { SharedContract } from "@seam/protocol";

/** Synthetic oracle for workflow tests, never a claim of real Agent delivery. */
export function fixtureContract(ids: string[], revision: number, extra = ""): SharedContract {
  return {
    effectiveRequirements: [{ id: "quote", text: "报价接口正常响应和错误边界" }], retiredRequirements: [], serviceExpectations: [],
    scope: "仅在隔离合成项目中实施报价 HTTP 接口，对齐双方字段与错误语义。" + extra,
    interfaces: [{ id: "quote", definition: "POST /quote 接收 SKU 与整数数量，返回整数分 subtotal 与 CNY 币种；无效输入返回 HTTP 400。" + (revision > 1 ? "discountPercent 为 0 到 100 的整数，缺省为 0，显式 null 和布尔值非法。" : "") }],
    responsibilities: ids.map((participantId) => ({ participantId, changes: "按共同契约完成本方合成接口实现、单元测试并运行本轮真实 HTTP 联合验证。" })),
    acceptanceCases: ids.map((runnerParticipantId, index) => ({ id: `joint-${index + 1}`, runnerParticipantId, description: "真实请求对端报价接口，验证正常响应和无效数量边界", command: "node --test joint.test.mjs", expectedResult: "退出码 0，正常报价正确，非法输入返回 400", requiredAssertions: ["fixture HTTP contract"] })),
    risks: "只允许隔离合成环境；服务或权限不可用时如实提交未执行，不能伪造通过。",
    changeSummary: revision === 1 ? "首次统一接口、项目职责和联合验收用例。" + extra : "复用基础报价约定，仅追加折扣与兼容性验收。" + extra,
    impactedParticipantIds: ids, retainedDecisions: revision > 1 ? ["保留 POST /quote 路径、SKU 和整数分金额约定"] : [],
  };
}

export function fixtureRuns(id: string) {
  return [{ id: `fixture-${id}`, command: "node --test joint.test.mjs", exitCode: 0,
    output: "Explicit synthetic protocol fixture; no real command execution claimed.", assertions: ["fixture HTTP contract"], source: "local-test" as const, capturedAt: new Date().toISOString() }];
}
