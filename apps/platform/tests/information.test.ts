import { describe, expect, it } from "vitest";
import { collaborationContextSchema, informationTaskFor } from "@seam/protocol";
import { answerInformationRequest, openInformationRequest } from "../src/lib/information";

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
  const old=[0,1,2].map(()=>({...open().request!,status:"answered" as const}));expect(open({requests:old}).request).toBeNull();
 });
 it("已提交本方实施报告的对端仍能收到只读查询；暂停、旧修订和旧阶段不分配",()=>{
  const r=open({searched:sources}).request!;
  const value=collaborationContextSchema.parse({collaborationId:crypto.randomUUID(),title:"信息查询",type:"custom",status:"in_progress",objective:"报价",participant:{id:b,projectId:crypto.randomUUID(),projectName:"peer",agentId:null,agentName:null,role:"provider",approvalRequired:true,status:"active"},participants:[],messages:[],artifacts:[],workItems:[],lifecycle:{revision:1,phase:"executing",requirements:"目标",document:"方案",documentHash:"a".repeat(64),approvedHash:"a".repeat(64),requiredParticipantIds:[a,b],contributions:[],confirmations:[],reports:[{participantId:b,status:"passed",summary:"已完成",evidence:{}}],report:null,informationRequests:[r]}});
  const l=value.lifecycle!;expect(informationTaskFor(l,b)).toEqual({requestId:r.id,mode:"peer"});expect(informationTaskFor(l,a)).toBeNull();
  expect(informationTaskFor({...l,paused:true},b)).toBeNull();expect(informationTaskFor({...l,revision:2},b)).toBeNull();expect(informationTaskFor({...l,phase:"joint_verifying"},b)).toBeNull();
 });
});
