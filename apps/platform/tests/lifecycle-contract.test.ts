import { describe, expect, it } from "vitest";
import { contractChanges, renderSharedContract, validateSharedContract } from "../src/lib/lifecycle-contract";
import { fixtureContract } from "./fixtures/shared-contract";

const ids = [crypto.randomUUID(), crypto.randomUUID()];
describe("统一契约与增量审阅", () => {
  it("完整文档共用相同HTTP定义，各端引用与所有响应约束仍完整",()=>{
    const contract=fixtureContract(ids,1);
    const check={id:"left",publisherParticipantId:ids[0]!,serviceName:"quote",method:"POST" as const,path:"/quote",requestBody:'{"quantity":0}',expectedStatus:400,bodyChecks:[],bodyAssertions:[{path:"error",type:"string" as const,nonEmpty:true}],headerChecks:[{name:"content-type",includes:"application/json"}],emptyBody:false};
    contract.acceptanceCases[0]!.httpChecks=[check];contract.acceptanceCases[1]!.httpChecks=[{...check,id:"right"}];
    const document=renderSharedContract({title:"合成",revision:1,requirements:"明确错误语义",changeRequest:null,contract,names:new Map(ids.map(id=>[id,"项目"])),baselines:[]});
    expect(document.match(/### HTTP-1\n/g)).toHaveLength(1);expect(document).not.toContain("### HTTP-2");expect(document).toContain("left → HTTP-1");expect(document).toContain("right → HTTP-1");expect(document).toContain("error:string，非空");expect(document).toContain('content-type 包含 "application/json"');expect(document).toContain(JSON.stringify(check.requestBody));
  });
  it("协议8错误响应不能仅有状态码，明确空正文与字段类型均受校验",()=>{
    const contract=fixtureContract(ids,1);contract.serviceExpectations=[{name:"quote",publisherParticipantId:ids[0]!,healthPath:"/health",status:200,bodyChecks:[]}];
    const check={id:"error",publisherParticipantId:ids[0]!,serviceName:"quote",method:"POST" as const,path:"/quote",requestBody:"null",expectedStatus:400,bodyChecks:[]};contract.acceptanceCases[0]!.httpChecks=[check];
    expect(()=>validateSharedContract(contract,ids,null,false,false,true)).toThrow("仅状态码");
    contract.acceptanceCases[0]!.httpChecks![0]={...check,headerChecks:[{name:"content-type",includes:"application/json"}],bodyAssertions:[{path:"error",type:"string",nonEmpty:true}]};expect(()=>validateSharedContract(contract,ids,null,false,false,true)).not.toThrow();
    contract.acceptanceCases[0]!.httpChecks![0]!.emptyBody=true;expect(()=>validateSharedContract(contract,ids,null,false,false,true)).toThrow("空正文");
  });
  it("按需求ID检查独立覆盖，拒绝重复正常请求冒充错误场景",()=>{
    const contract=fixtureContract(ids,1);contract.effectiveRequirements=[{id:"normal",text:"正常响应",verification:"http"},{id:"errors",text:"无效请求拒绝",verification:"http"}];contract.serviceExpectations=[{name:"quote",publisherParticipantId:ids[0]!,healthPath:"/health",status:200,bodyChecks:[]}];
    const good={id:"normal",requirementIds:["normal"],publisherParticipantId:ids[0]!,serviceName:"quote",method:"POST" as const,path:"/quote",requestBody:'{"quantity":2}',expectedStatus:200,bodyChecks:[{path:"subtotal",equals:24000}]};
    contract.acceptanceCases[0]!.httpChecks=[good];expect(()=>validateSharedContract(contract,ids,null,true,true)).toThrow("每项HTTP要求");
    contract.acceptanceCases[0]!.httpChecks!.push({...good,id:"fake-error",requirementIds:["errors"]});expect(()=>validateSharedContract(contract,ids,null,true,true)).toThrow("不同请求");
    contract.acceptanceCases[0]!.httpChecks![1]={...good,id:"real-error",requirementIds:["errors"],requestBody:'{"quantity":0}',expectedStatus:400,bodyChecks:[]};expect(()=>validateSharedContract(contract,ids,null,true,true)).not.toThrow();
    contract.acceptanceCases[0]!.httpChecks![1]!.requirementIds=["unknown"];expect(()=>validateSharedContract(contract,ids,null,true,true)).toThrow("要求ID");
  });
  it("API服务的独立验收必须有业务期望，拒绝跨方服务、越界路径及未授权测试变更", () => {
    const contract=fixtureContract(ids,1);
    contract.serviceExpectations=[{name:"quote",publisherParticipantId:ids[0]!,healthPath:"/health",status:200,bodyChecks:[]}];
    expect(()=>validateSharedContract(contract,ids,null,true)).toThrow("独立业务HTTP检查");
    const check={id:"amount",publisherParticipantId:ids[0]!,serviceName:"quote",method:"POST" as const,path:"/quote",requestBody:'{"quantity":2}',expectedStatus:200,bodyChecks:[{path:"subtotal",equals:24000}]};
    contract.acceptanceCases[0]!.httpChecks=[check];expect(()=>validateSharedContract(contract,ids,null,true)).not.toThrow();
    for(const invalid of [{...check,path:"//outside.invalid"},{...check,publisherParticipantId:ids[1]!},{...check,method:"GET" as const},{...check,bodyChecks:[{path:"x[0]",equals:1}]}]) {
      contract.acceptanceCases[0]!.httpChecks=[invalid];expect(()=>validateSharedContract(contract,ids,null,true)).toThrow("独立HTTP验收");
    }
    contract.acceptanceCases[0]!.httpChecks=[check];contract.testChanges=[{participantId:ids[0]!,path:"../outside.test.mjs",reason:"bad"}];expect(()=>validateSharedContract(contract,ids)).toThrow("相对文件路径");
  });
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
