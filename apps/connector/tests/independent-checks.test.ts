import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { collaborationContextSchema } from "@seam/protocol";
import { runIndependentChecks, buildConfiguredIntegrationReport } from "../src/independent-checks";
import { captureCommand } from "../src/evidence";
let server:Server,base:string,subtotal:number,requests:number;
const a=crypto.randomUUID(),b=crypto.randomUUID(),hash="a".repeat(64);
beforeEach(async()=>{subtotal=24001;requests=0;server=createServer((req,res)=>{requests++;res.setHeader("content-type","application/json");res.end(JSON.stringify({subtotal,revision:2}));});await new Promise<void>(resolve=>server.listen(0,"127.0.0.1",resolve));base=`http://127.0.0.1:${(server.address() as {port:number}).port}`;});
afterEach(async()=>{await new Promise<void>(resolve=>server.close(()=>resolve()));});
const context=()=>collaborationContextSchema.parse({collaborationId:crypto.randomUUID(),title:"oracle",type:"api-integration",status:"in_progress",objective:"真实金额",participant:{id:a,projectId:crypto.randomUUID(),projectName:"consumer",agentId:null,agentName:null,role:"consumer",approvalRequired:true,status:"active"},participants:[],messages:[],artifacts:[],workItems:[],lifecycle:{revision:2,phase:"joint_verifying",requirements:"quote",document:"approved",documentHash:hash,approvedHash:hash,requiredParticipantIds:[a,b],contributions:[],confirmations:[],reports:[],report:null,services:[{participantId:b,name:"quote",baseUrl:base,healthPath:"/health",ttlSeconds:300,expiresAt:new Date(Date.now()+60000).toISOString()}],contract:{scope:"报价接口真实金额验证".repeat(3),interfaces:[{id:"quote",definition:"实现真实报价请求及金额校验".repeat(3)}],responsibilities:[a,b].map(participantId=>({participantId,changes:"分别实现与验证报价接口的真实响应".repeat(3)})),acceptanceCases:[{id:"consumer",runnerParticipantId:a,description:"真实报价金额与已批准期望一致",command:"node --test joint.test.mjs",expectedResult:"subtotal=24000",requiredAssertions:["quote amount"],httpChecks:[{id:"amount",publisherParticipantId:b,serviceName:"quote",method:"POST",path:"/quote",requestBody:'{"sku":"SKU-001","quantity":2}',expectedStatus:200,bodyChecks:[{path:"subtotal",equals:24000},{path:"revision",equals:"$SEAM_REVISION"}]}]},{id:"provider",runnerParticipantId:b,description:"提供方独立验证接口的真实响应",command:"node --test joint.test.mjs",expectedResult:"正确"}],risks:"仅本地合成HTTP",changeSummary:"验证独立金额检查与模型报告分开",impactedParticipantIds:[a,b],retainedDecisions:[]}}});

describe("固定Connector独立验收与自动回执",()=>{
 it("同名测试虚假通过也不能掩盖真实HTTP错误，修正后独立检查通过",async()=>{
  const ctx=context(),signal=new AbortController().signal;
  const run=captureCommand({id:"observed",command:"node --test joint.test.mjs",exitCode:0,output:"TAP version 13\nok 1 - quote amount\n"},"","local-test")!;
  let results=await runIndependentChecks(ctx,true,signal);expect(results[0]!.status).toBe("failed");expect(results[0]!.specHash).toHaveLength(64);
  expect((buildConfiguredIntegrationReport(ctx,"node --test joint.test.mjs",[run],results)!.actions[0] as any).checks[0]).toMatchObject({status:"failed",category:"code"});
  subtotal=24000;results=await runIndependentChecks(ctx,true,signal);expect(results[0]).toMatchObject({status:"passed",documentHash:hash,actualStatus:200});
  const receipt=buildConfiguredIntegrationReport(ctx,"node --test joint.test.mjs",[run],results)!;expect((receipt.actions[0] as any).checks[0]).toMatchObject({status:"passed",runIds:[run.id]});
  expect(buildConfiguredIntegrationReport(ctx,"some-other-local-command",[run],results)).toBeNull();
 });
 it("缺权限、服务过期及只读查询均不发请求或伪称已验证",async()=>{
  const ctx=context(),signal=new AbortController().signal;
  expect((await runIndependentChecks(ctx,false,signal))[0]).toMatchObject({status:"not_run",category:"authorization"});expect(requests).toBe(0);
  ctx.lifecycle!.services[0]!.expiresAt=new Date(0).toISOString();expect((await runIndependentChecks(ctx,true,signal))[0]).toMatchObject({status:"not_run",category:"environment"});expect(requests).toBe(0);
  ctx.informationTask={requestId:crypto.randomUUID(),mode:"peer"};expect(await runIndependentChecks(ctx,true,signal)).toEqual([]);expect(requests).toBe(0);
 });
 it("批准指纹不匹配及越出服务origin的路径不触发网络请求",async()=>{
  const ctx=context(),signal=new AbortController().signal;ctx.lifecycle!.approvedHash="b".repeat(64);expect(await runIndependentChecks(ctx,true,signal)).toEqual([]);
  ctx.lifecycle!.approvedHash=hash;ctx.lifecycle!.paused=true;expect(await runIndependentChecks(ctx,true,signal)).toEqual([]);expect(buildConfiguredIntegrationReport(ctx,"node --test joint.test.mjs",[],[])).toBeNull();ctx.lifecycle!.paused=false;
  ctx.lifecycle!.approvedHash=hash;ctx.lifecycle!.contract!.acceptanceCases[0]!.httpChecks![0]!.path="//outside.invalid/";
  expect((await runIndependentChecks(ctx,true,signal))[0]!.status).toBe("not_run");expect(requests).toBe(0);
 });
});
