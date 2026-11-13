import {describe,expect,it} from "vitest";
import {fixtureContract} from "./fixtures/shared-contract";
import {validateRepairContract} from "../src/lib/repair";

describe("修复不能通过削减目标与验收换取通过",()=>{
 const ids=[crypto.randomUUID(),crypto.randomUUID()];
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
