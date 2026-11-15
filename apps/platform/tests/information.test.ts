import { describe, expect, it } from "vitest";
import { collaborationContextSchema, informationTaskFor } from "@seam/protocol";
import { answerInformationRequest, openInformationRequest, expireInformationRequest, factFromRequest, administratorFact } from "../src/lib/information";

const a=crypto.randomUUID(),b=crypto.randomUUID(),c=crypto.randomUUID();
const sources=[{scope:"local_project" as const,reference:"README.md",finding:"本项目没有对端金额规则"},{scope:"shared_context" as const,reference:"当前共享契约及产物",finding:"共享资料尚未包含税率"}];
const open=(extra={})=>openInformationRequest({requests:[],id:crypto.randomUUID(),revision:1,phase:"executing",participantId:a,requiredParticipantIds:[a,b],question:"对端报价金额的税率和取整规则是什么？",now:new Date().toISOString(),...extra});
const respond=(requestId:string,status:"found"|"unavailable",extra={})=>({type:"information.respond" as const,revision:1,requestId,status,answer:status==="found"?"税率为6%，按整数分向下取整，来源docs/quote.md":"已检查资料，没有找到税率事实",sources,...extra});

describe("只读事实查找的持久状态",()=>{
 it("先查本地与共享；缺失后询证对端；仅指定参与方可以答复",()=>{
  const r=open().request!;expect(r.stage).toBe("local");
  expect(()=>answerInformationRequest(r,b,respond(r.id,"found"),"executing")).toThrow("分配");
  const peer=answerInformationRequest(r,a,respond(r.id,"unavailable"),"executing");expect(peer.stage).toBe("peer");expect(peer.status).toBe("pending");
  expect(()=>answerInformationRequest(peer,c,respond(r.id,"found"),"executing")).toThrow("分配");
  const done=answerInformationRequest(peer,b,respond(r.id,"found"),"executing");expect(done.status).toBe("answered");expect(done.responses).toHaveLength(2);expect(done.answer).toContain("6%");
  expect(()=>answerInformationRequest(done,b,respond(r.id,"found"),"executing")).toThrow("失效");
 });
 it("本地已找到时直接续接；所有对端均未找到后才交给管理员",()=>{
  const r=open().request!;expect(answerInformationRequest(r,a,respond(r.id,"found"),"executing").status).toBe("answered");
  const peer=answerInformationRequest(r,a,respond(r.id,"unavailable"),"executing");
  const missing=answerInformationRequest(peer,b,respond(r.id,"unavailable"),"executing");expect(missing.status).toBe("needs_admin");expect(missing.responses).toHaveLength(2);
 });
 it("显式询证必须先记录两类查找；拒绝秘密文件、绝对路径和陈旧修订",()=>{
  expect(()=>open({searched:[sources[0]]})).toThrow("本地项目与共享");
  expect(()=>open({searched:[{...sources[0],reference:".env"},sources[1]]})).toThrow("秘密");
  expect(()=>open({searched:[{...sources[0],reference:"/Users/person/private"},sources[1]]})).toThrow("相对");
  const r=open({searched:sources}).request!;expect(r.stage).toBe("peer");
  expect(()=>answerInformationRequest(r,b,respond(r.id,"found",{revision:2}),"executing")).toThrow("失效");
  expect(()=>answerInformationRequest(r,b,respond(r.id,"found"),"joint_verifying")).toThrow("失效");
 });
 it("多端答复收齐后归档，保留所有来源；重复等待去重且每方每版有界",()=>{
  const r=open({requiredParticipantIds:[a,b,c],searched:sources}).request!;
  const first=answerInformationRequest(r,b,respond(r.id,"found"),"executing");expect(first.status).toBe("pending");
  const done=answerInformationRequest(first,c,respond(r.id,"found"),"executing");expect(done.status).toBe("answered");expect(done.responses).toHaveLength(3);
  expect(open({requests:[r]}).requests).toHaveLength(1);
  const old=[0,1,2].map(()=>({...open().request!,status:"answered" as const}));expect(open({requests:old}).request).not.toBeNull();
  expect(open({requests:old.map(row=>({...row,status:"needs_admin" as const}))}).request).toBeNull();
 });
 it("已提交本方实施报告的对端仍能收到只读查询；暂停、旧修订和旧阶段不分配",()=>{
  const r=open({searched:sources}).request!;
  const value=collaborationContextSchema.parse({collaborationId:crypto.randomUUID(),title:"信息查询",type:"custom",status:"in_progress",objective:"报价",participant:{id:b,projectId:crypto.randomUUID(),projectName:"peer",agentId:null,agentName:null,role:"provider",approvalRequired:true,status:"active"},participants:[],messages:[],artifacts:[],workItems:[],lifecycle:{revision:1,phase:"executing",requirements:"目标",document:"方案",documentHash:"a".repeat(64),approvedHash:"a".repeat(64),requiredParticipantIds:[a,b],contributions:[],confirmations:[],reports:[{participantId:b,status:"passed",summary:"已完成",evidence:{}}],report:null,informationRequests:[r]}});
  const l=value.lifecycle!;expect(informationTaskFor(l,b)).toEqual({requestId:r.id,mode:"peer",attempt:1});expect(informationTaskFor(l,a)).toBeNull();
  expect(informationTaskFor({...l,paused:true},b)).toBeNull();expect(informationTaskFor({...l,revision:2},b)).toBeNull();expect(informationTaskFor({...l,phase:"joint_verifying"},b)).toBeNull();
 });
 it("独立问题成功查清后不消耗其他问题的失败预算",()=>{
  const done=[1,2,3].map(i=>({...open().request!,key:`fact-${i}`,question:`不同事实问题${i}`,status:"answered" as const}));
  expect(open({requests:done,key:"fact-4"}).request).not.toBeNull();
  const failed={...open({key:"fact-1"}).request!,status:"needs_admin" as const,retryCount:2};
  expect(open({requests:[failed],key:"fact-1"}).request).toBeNull();
  expect(open({requests:[failed],key:"fact-2"}).request).not.toBeNull();
 });
 it("超时按持久化deadline退避三次，迟到的旧attempt答复不能解锁新轮次",()=>{
  let request=open({searched:sources}).request!;
  for(let i=0;i<3;i++)request=expireInformationRequest(request,Date.parse(request.deadlineAt!)+1);
  expect(request.status).toBe("needs_admin");expect(request.attempt).toBe(3);
  const retried=expireInformationRequest(open({searched:sources}).request!,Date.now()+700_000);
  expect(retried.retryAt).toBeTruthy();expect(retried.attempt).toBe(2);
  expect(()=>answerInformationRequest(retried,b,respond(retried.id,"found",{attempt:1}),"executing")).toThrow("轮次");
 });
 it("矛盾的规范值标记冲突并重新核对，双方在新轮次确认一致后才归档",()=>{
  const request=open({requiredParticipantIds:[a,b,c],searched:sources,key:"quote.version"}).request!;
  const first=answerInformationRequest(request,b,respond(request.id,"found",{value:"v1"}),"executing");
  const conflict=answerInformationRequest(first,c,respond(request.id,"found",{value:"v2"}),"executing");
  expect(conflict.status).toBe("conflicted");expect(conflict.stage).toBe("reconcile");expect(conflict.attempt).toBe(2);
  const next=answerInformationRequest(conflict,b,respond(request.id,"found",{value:"v2",attempt:2}),"executing");
  const done=answerInformationRequest(next,c,respond(request.id,"found",{value:"v2",attempt:2}),"executing");
  expect(done.status).toBe("answered");expect(factFromRequest(done)!.value).toBe("v2");expect(done.responses).toHaveLength(5);
 });
 it("跨修订复用事实需要复核原资料；过期不复用，变更来源转回重新查找",()=>{
  const request=open({searched:sources,key:"quote.tax"}).request!;
  const done=answerInformationRequest(request,b,respond(request.id,"found",{value:"0.06"}),"executing");
  const fact=factFromRequest(done)!;
  const verify=open({revision:2,key:"quote.tax",facts:[fact]}).request!;expect(verify.stage).toBe("verify");expect(verify.targetParticipantIds).toEqual([b]);
  const rejected=answerInformationRequest(verify,b,respond(verify.id,"unavailable",{revision:2}),"executing");expect(rejected.stage).toBe("local");expect(rejected.attempt).toBe(2);
  expect(open({key:"quote.tax",facts:[{...fact,validUntil:new Date(0).toISOString()}]}).request!.stage).toBe("local");
  const human=administratorFact(request,"税率由管理员确认6%");
  expect(open({revision:3,key:"quote.tax",facts:[human]}).request!.status).toBe("answered");
 });
});
