import { describe, expect, it } from "vitest";
import { contractChanges, renderSharedContract, validateSharedContract } from "../src/lib/lifecycle-contract";
import { fixtureContract } from "./fixtures/shared-contract";

const ids = [crypto.randomUUID(), crypto.randomUUID()];
describe("统一契约与增量审阅", () => {
  it("五轮替换、恢复及撤销保留有效清单，遗漏旧要求必须明确撤销且不能撤销未知ID", () => {
    let previous = fixtureContract(ids, 1);
    previous.effectiveRequirements = [{ id: "quantity", text: "1到100" }, { id: "compatibility", text: "保留四字段" }];
    for (let revision = 2; revision <= 5; revision++) {
      const current = fixtureContract(ids, revision);
      current.effectiveRequirements = [{ id: "quantity", text: revision === 3 ? "1到50" : "1到100" }, { id: "compatibility", text: "保留四字段" }, ...(revision < 5 ? [{ id: "discount", text: "支持折扣" }] : [])];
      current.retiredRequirements = revision === 5 ? [{ id: "discount", reason: "管理员明确撤销折扣" }] : [];
      expect(() => validateSharedContract(current, ids, previous)).not.toThrow();
      if (revision === 5) {
        expect(() => validateSharedContract({ ...current, retiredRequirements: [] }, ids, previous)).toThrow("撤销");
        expect(() => validateSharedContract({ ...current, retiredRequirements: [{ id: "unknown", reason: "未知" }] }, ids, previous)).toThrow("撤销");
      }
      previous = current;
    }
  });
  it("新文档不能以空断言集或重复断言冒充完整验收", () => {
    const contract = fixtureContract(ids, 1);
    for (const requiredAssertions of [undefined, [], ["health", "health"]]) expect(() => validateSharedContract({ ...contract, acceptanceCases: contract.acceptanceCases.map((item) => ({ ...item, requiredAssertions })) }, ids)).toThrow("必需断言");
    expect(() => validateSharedContract({ ...contract, serviceExpectations: undefined }, ids)).toThrow("服务就绪契约");
  });
  it("遗漏项目、跨方用例和重复ID不能进入文档确认", () => {
    const contract = fixtureContract(ids, 1);
    expect(() => validateSharedContract({ ...contract, responsibilities: contract.responsibilities.slice(1) }, ids)).toThrow("责任划分");
    expect(() => validateSharedContract({ ...contract, acceptanceCases: [contract.acceptanceCases[0]!, contract.acceptanceCases[0]!] }, ids)).toThrow("ID");
    expect(() => validateSharedContract({ ...contract, acceptanceCases: contract.acceptanceCases.map((item) => ({ ...item, runnerParticipantId: crypto.randomUUID() })) }, ids)).toThrow("联合验收");
  });
  it("增量文档包含实际接口差异、保留决定和完整不变职责", () => {
    const previous = fixtureContract(ids, 1), current = fixtureContract(ids, 2);
    expect(contractChanges(previous, current)).toContain("接口 quote：修改");
    expect(contractChanges(previous, current).some((item) => item.startsWith("项目职责"))).toBe(false);
    const document = renderSharedContract({ title: "报价", revision: 2, requirements: "基础报价并追加折扣", changeRequest: "新增折扣", contract: current, previous, names: new Map(ids.map((id, index) => [id, `项目${index}`])), baselines: [] });
    expect(document).toContain("保留 POST /quote");
    expect(document).toContain(current.responsibilities[0]!.changes);
    expect(document).toContain("历史测试只作参考");
    expect(document).toContain("接口 quote：修改");
  });
});
