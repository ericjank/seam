import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { collaborationContextSchema } from "@seam/protocol";
import { runIndependentChecks, buildConfiguredIntegrationReport } from "../src/independent-checks";
import { captureCommand } from "../src/evidence";
let server:Server,base:string,subtotal:number,requests:number,mode:string;
const a=crypto.randomUUID(),b=crypto.randomUUID(),hash="a".repeat(64);
beforeEach(async()=>{subtotal=24001;requests=0;mode="normal";server=createServer((req,res)=>{requests++;res.setHeader("content-type","application/json");if(mode.startsWith("error_")){res.statusCode=400;if(mode==="error_html"){res.setHeader("content-type","text/html");res.end(JSON.stringify({error:"invalid input"}));}else if(mode==="error_invalid_json")res.end("{broken");else if(mode==="error_empty_body")res.end();else res.end(JSON.stringify(mode==="error_missing"?{}:{error:mode==="error_null"?null:mode==="error_number"?123:mode==="error_blank"?"  ":"invalid input"}));return;}if(mode==="stream_abort"){res.write('{"subtotal":');setTimeout(()=>res.destroy(),25);return;}if(mode==="unauthorized"){res.writeHead(401).end('{}');return;}if(mode==="invalid_json"){res.end('{broken');return;}if(mode==="oversize"){res.end('x'.repeat(66000));return;}res.end(JSON.stringify({subtotal,revision:2}));});await new Promise<void>(resolve=>server.listen(0,"127.0.0.1",resolve));base=`http://127.0.0.1:${(server.address() as {port:number}).port}`;});
afterEach(async()=>{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));});
const context=()=>collaborationContextSchema.parse({collaborationId:crypto.randomUUID(),title:"oracle",type:"api-integration",status:"in_progress",objective:"真实金额",participant:{id:a,projectId:crypto.randomUUID(),projectName:"consumer",agentId:null,agentName:null,role:"consumer",approvalRequired:true,status:"active"},participants:[],messages:[],artifacts:[],workItems:[],lifecycle:{revision:2,phase:"joint_verifying",requirements:"quote",document:"approved",documentHash:hash,approvedHash:hash,requiredParticipantIds:[a,b],contributions:[],confirmations:[],reports:[],report:null,services:[{participantId:b,name:"quote",baseUrl:base,healthPath:"/health",ttlSeconds:300,expiresAt:new Date(Date.now()+60000).toISOString()}],contract:{scope:"报价接口真实金额验证".repeat(3),interfaces:[{id:"quote",definition:"实现真实报价请求及金额校验".repeat(3)}],responsibilities:[a,b].map(participantId=>({participantId,changes:"分别实现与验证报价接口的真实响应".repeat(3)})),acceptanceCases:[{id:"consumer",runnerParticipantId:a,description:"真实报价金额与已批准期望一致",command:"node --test joint.test.mjs",expectedResult:"subtotal=24000",requiredAssertions:["quote amount"],httpChecks:[{id:"amount",publisherParticipantId:b,serviceName:"quote",method:"POST",path:"/quote",requestBody:'{"sku":"SKU-001","quantity":2}',expectedStatus:200,bodyChecks:[{path:"subtotal",equals:24000},{path:"revision",equals:"$SEAM_REVISION"}]}]},{id:"provider",runnerParticipantId:b,description:"提供方独立验证接口的真实响应",command:"node --test joint.test.mjs",expectedResult:"正确"}],risks:"仅本地合成HTTP",changeSummary:"验证独立金额检查与模型报告分开",impactedParticipantIds:[a,b],retainedDecisions:[]}}});

describe("固定Connector独立验收与自动回执",()=>{
 it.each(["error_missing","error_null","error_number","error_blank","error_html","error_invalid_json","error_empty_body"])("HTTP400也必须验证错误正文和响应头：%s",async value=>{
  mode=value;const ctx=context(),check=ctx.lifecycle!.contract!.acceptanceCases[0]!.httpChecks![0]!;check.expectedStatus=400;check.bodyChecks=[];check.bodyAssertions=[{path:"error",type:"string",nonEmpty:true}];check.headerChecks=[{name:"content-type",includes:"application/json"}];
  const result=(await runIndependentChecks(ctx,true,new AbortController().signal))[0]!;expect(result).toMatchObject({status:"failed",category:"code"});
  const run=captureCommand({id:"model-claims-pass",command:"node --test joint.test.mjs",exitCode:0,output:"ok 1 - quote amount\n"},"","local-test")!;
  expect((buildConfiguredIntegrationReport(ctx,"node --test joint.test.mjs",[run],[result])!.actions[0] as any).checks[0].status).toBe("failed");
 });
 it("正确错误正文通过，明确批准空正文时精确检查字节数",async()=>{
  mode="error_valid";const ctx=context(),check=ctx.lifecycle!.contract!.acceptanceCases[0]!.httpChecks![0]!;check.expectedStatus=400;check.bodyChecks=[];check.bodyAssertions=[{path:"error",type:"string",nonEmpty:true}];check.headerChecks=[{name:"content-type",includes:"application/json"}];
  expect((await runIndependentChecks(ctx,true,new AbortController().signal))[0]!.status).toBe("passed");
  check.bodyAssertions=[];check.emptyBody=true;expect((await runIndependentChecks(ctx,true,new AbortController().signal))[0]!.status).toBe("failed");
  mode="error_empty_body";expect((await runIndependentChecks(ctx,true,new AbortController().signal))[0]!.status).toBe("passed");
 });

 it.each(["stream_abort","unauthorized","invalid_json","oversize"])("真实HTTP异常%s按阶段分类，不把传输或策略限制当成代码错误",async value=>{
  mode=value;const results=await runIndependentChecks(context(),true,new AbortController().signal),result=results[0]!;
  const expected={stream_abort:{status:"not_run",category:"environment",failureStage:"read_body"},unauthorized:{status:"not_run",category:"authorization",failureStage:"permission"},invalid_json:{status:"failed",category:"code",failureStage:"parse"},oversize:{status:"not_run",category:"environment",failureStage:"policy"}};
  expect(result).toMatchObject(expected[value as keyof typeof expected]);
 });
 it("实际字段差异保留精确期望和响应值供只读修复定位，不复制整个响应",async()=>{
  const [result]=await runIndependentChecks(context(),true,new AbortController().signal);expect(result!.mismatches).toEqual([{path:"subtotal",expected:24000,actual:24001,actualPresent:true}]);
 });
 it("已取消的任务传播取消，不产生代码失败结论",async()=>{
  const control=new AbortController();control.abort(new Error("owned cancellation"));await expect(runIndependentChecks(context(),true,control.signal)).rejects.toThrow("owned cancellation");expect(requests).toBe(0);
 });
 it("同名测试虚假通过也不能掩盖真实HTTP错误，修正后独立检查通过",async()=>{
  const ctx=context(),signal=new AbortController().signal;
  const run=captureCommand({id:"observed",command:"node --test joint.test.mjs",exitCode:0,output:"TAP version 13\nok 1 - quote amount\n"},"","local-test")!;
  let results=await runIndependentChecks(ctx,true,signal);expect(results[0]!.status).toBe("failed");expect(results[0]!.specHash).toHaveLength(64);
  const failure=(buildConfiguredIntegrationReport(ctx,"node --test joint.test.mjs",[run],results)!.actions[0] as any).checks[0];expect(failure).toMatchObject({status:"failed",category:"code"});expect(failure.summary).toContain("subtotal 期望24000，实际24001");expect(failure.evidence.rootCauses[0].publisherParticipantId).toBe(b);
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
