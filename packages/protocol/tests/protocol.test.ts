import { describe, expect, it } from "vitest";
import { MAX_TEST_FINGERPRINT_FILES, agentTurnResultSchema, contentHash, lifecycleAgentActionSchema } from "../src/index";

describe("协作协议", () => {
  it("校验结构化 Agent 返回并填充默认值", () => {
    const result = agentTurnResultSchema.parse({ message: "确认契约" });
    expect(result.kind).toBe("chat");
    expect(result.actions).toEqual([]);
    expect(result.needsHumanInput).toBe(false);
  });

  it("拒绝未知动作", () => {
    expect(() => agentTurnResultSchema.parse({ message: "x", actions: [{ type: "source.upload" }] })).toThrow();
  });

  it("生成稳定内容哈希", async () => {
    expect(await contentHash("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });

  it.each([508, MAX_TEST_FINGERPRINT_FILES, MAX_TEST_FINGERPRINT_FILES + 1])("计划、命令与两类报告统一校验 %s 项指纹", (count) => {
    const sha256 = "a".repeat(64);
    const capturedAt = new Date().toISOString();
    const testFiles = Array.from({ length: count }, (_, index) => ({ path: `tests/${index}.test.ts`, sha256 }));
    const run = { id: "run", command: "node --test", output: "", exitCode: 0, assertions: [], source: "local-test", capturedAt, testFiles };
    const actions = [
      { type: "plan.submit", revision: 1, content: "先核对正式测试入口，再准备协作实施计划。".repeat(8), baseline: { head: null, treeHash: sha256, capturedAt, testFiles } },
      { type: "execution.report", revision: 1, status: "passed", summary: "测试已执行", testFiles },
      { type: "execution.report", revision: 1, status: "passed", summary: "测试已执行", runs: [run] },
      { type: "integration.report", revision: 1, documentHash: sha256, checks: [{ caseId: "joint", status: "not_run", summary: "合成校验夹具", command: "" }], testFiles },
    ];
    for (const action of actions) {
      expect(lifecycleAgentActionSchema.safeParse(action).success).toBe(count <= MAX_TEST_FINGERPRINT_FILES);
    }
  });
});

it('HTTP规范只保存一份，展开后两端检查ID和期望分别保持',async()=>{
 const{normalizeSharedContract,expandSharedContract}=await import('../src/index');
 const spec={id:'left',publisherParticipantId:crypto.randomUUID(),serviceName:'quote',method:'POST' as const,path:'/quote',requestBody:'{}',expectedStatus:400,bodyChecks:[],bodyAssertions:[{path:'error',type:'string' as const,nonEmpty:true}],headerChecks:[{name:'content-type',includes:'application/json'}]};
 const contract={acceptanceCases:[{id:'a',httpChecks:[spec]},{id:'b',httpChecks:[{...spec,id:'right'}]}]}as unknown as import('../src/index').SharedContract;
 const compact=normalizeSharedContract(contract);expect(compact.httpDefinitions).toHaveLength(1);expect(compact.acceptanceCases.every(row=>!row.httpChecks)).toBe(true);const expanded=expandSharedContract(compact);expect(expanded.acceptanceCases.map(row=>row.httpChecks?.[0]?.id)).toEqual(['left','right']);expect(expanded.acceptanceCases[1]!.httpChecks![0]!.bodyAssertions).toEqual(spec.bodyAssertions);
 expect(()=>expandSharedContract({...compact,httpDefinitions:[]})).toThrow('引用不存在');expect(()=>expandSharedContract({...compact,httpDefinitions:[compact.httpDefinitions![0]!,compact.httpDefinitions![0]!]})).toThrow('ID重复');
});
