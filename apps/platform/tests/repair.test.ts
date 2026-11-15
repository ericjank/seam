import {describe,expect,it} from "vitest";
import {fixtureContract} from "./fixtures/shared-contract";
import {validateRepairContract,validatePinnedTests,repairFailures} from "../src/lib/repair";

describe("修复不能通过削减目标与验收换取通过",()=>{
 const ids=[crypto.randomUUID(),crypto.randomUUID()];
 it("服务端复核固定测试指纹；授权只归当前项目，联合阶段不能再授权变更",()=>{
  const before=[{path:"joint.test.mjs",sha256:"a".repeat(64)}],after=[{path:"joint.test.mjs",sha256:"b".repeat(64)}];
  expect(()=>validatePinnedTests(before,undefined,[],ids[0]!)).toThrow("缺少");
  expect(()=>validatePinnedTests(before,after,[{participantId:ids[1]!,path:"joint.test.mjs",reason:"only other side"}],ids[0]!)).toThrow("未声明");
  expect(()=>validatePinnedTests(before,after,[{participantId:ids[0]!,path:"joint.test.mjs",reason:"reviewed"}],ids[0]!)).not.toThrow();
  expect(()=>validatePinnedTests(before,after,[],ids[0]!)).toThrow("已修改");
  expect(()=>validatePinnedTests(before,[...before,{path:"new.test.mjs",sha256:"c".repeat(64)}],[],ids[0]!,true)).toThrow("新增");
 });
 it("仅代码失败起草修复，环境权限缺失事实未知及未执行均不成为代码修复",()=>{
  for(const category of ["environment","authorization","missing_information","unknown"]) expect(repairFailures([{participantId:ids[0]!,reportStatus:"failed",reportSummary:"actual failure",reportEvidence:{category},integrationChecks:null}])).toEqual([]);
  expect(repairFailures([{participantId:ids[0]!,reportStatus:"failed",reportSummary:"actual code failure",reportEvidence:{category:"code"},integrationChecks:null}])).toHaveLength(1);
 });
 it("修复不能修改或删除独立HTTP期望来冒充通过",()=>{
  const prior=fixtureContract(ids,1);prior.acceptanceCases[0]!.httpChecks=[{id:"amount",publisherParticipantId:ids[0]!,serviceName:"quote",method:"POST",path:"/quote",requestBody:null,expectedStatus:200,bodyChecks:[{path:"subtotal",equals:24000}]}];
  const next=structuredClone(prior);next.acceptanceCases[0]!.httpChecks![0]!.bodyChecks[0]!.equals=24001;expect(()=>validateRepairContract(prior,next)).toThrow("独立HTTP检查");
  next.acceptanceCases[0]!.httpChecks=[];expect(()=>validateRepairContract(prior,next)).toThrow("独立HTTP检查");
 });
 it("保留要求和原验收覆盖，允许增加回归用例和调整实施步骤",()=>{
  const prior=fixtureContract(ids,1),next=structuredClone(prior);next.responsibilities[0]!.changes="定位失败证据，修正计算分支并增加真实回归测试。";next.acceptanceCases[0]!.requiredAssertions!.push("new regression");
  expect(()=>validateRepairContract(prior,next)).not.toThrow();
 });
 it("拒绝删要求、删用例、换执行方、删断言或削弱就绪",()=>{
  const prior=fixtureContract(ids,1);prior.serviceExpectations=[{name:"quote",publisherParticipantId:ids[0]!,healthPath:"/health",status:200,bodyChecks:[{path:"ready",equals:true},{path:"revision",equals:1}]}];
  const variants=[()=>{const n=structuredClone(prior);n.effectiveRequirements=[];return n;},()=>{const n=structuredClone(prior);n.acceptanceCases.pop();return n;},()=>{const n=structuredClone(prior);n.acceptanceCases[0]!.runnerParticipantId=ids[1]!;return n;},()=>{const n=structuredClone(prior);n.acceptanceCases[0]!.requiredAssertions=[];return n;},()=>{const n=structuredClone(prior);n.serviceExpectations![0]!.bodyChecks=[];return n;}];
  for(const get of variants)expect(()=>validateRepairContract(prior,get())).toThrow();
  const valid=structuredClone(prior);valid.serviceExpectations![0]!.bodyChecks[1]!.equals=2;expect(()=>validateRepairContract(prior,valid)).not.toThrow();
 });
});
