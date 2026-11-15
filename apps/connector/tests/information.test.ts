import {execFileSync} from "node:child_process";
import {mkdtemp,writeFile,readFile,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {beforeEach,afterEach,describe,expect,it,vi} from "vitest";
import {collaborationContextSchema} from "@seam/protocol";
import {MockAgentAdapter} from "@seam/agent-adapters";
import {readConfig} from "../src/config";
import {runConnector} from "../src/index";
import {hashProjectFile} from "../src/integrity";
import {workspaceBaseline} from "../src/workspace";
let root:string;
beforeEach(async()=>{root=await mkdtemp(join(tmpdir(),"seam-information-"));});
afterEach(async()=>{vi.unstubAllGlobals();vi.unstubAllEnvs();vi.restoreAllMocks();await rm(root,{recursive:true,force:true});});
describe("信息查找不会重新实施或运行验证",()=>{
 it("联合验收前测试被替换时，完整Connector停止在调用模型和本机命令之前",async()=>{
  await writeFile(join(root,"joint.test.mjs"),"original approved test");
  const frozen={path:"joint.test.mjs",sha256:(await hashProjectFile(root,"joint.test.mjs"))!};
  await writeFile(join(root,"joint.test.mjs"),"same name with weaker implementation");
  const git=(...args:string[])=>execFileSync("git",args,{cwd:root,stdio:"pipe"});git("init","--quiet");
  vi.stubEnv("SEAM_TEST_COMMAND",'node -e \'require("node:fs").writeFileSync("executed.marker","must not run")\'');
  const config=readConfig(["--once"],{SEAM_AGENT_ID:crypto.randomUUID(),SEAM_AGENT_TOKEN:"fixture-only",SEAM_PROJECT_ROOT:root});config.stateDir=join(root,"state");config.workspaceLockDir=join(root,"locks");
  const id=crypto.randomUUID(),context=collaborationContextSchema.parse({collaborationId:crypto.randomUUID(),title:"frozen tests",type:"custom",status:"in_progress",objective:"respect approved tests",participant:{id,projectId:crypto.randomUUID(),projectName:"consumer",agentId:config.agentId,agentName:"fixture",role:"consumer",approvalRequired:true,status:"active"},participants:[],messages:[],artifacts:[],workItems:[],lifecycle:{revision:1,phase:"joint_verifying",requirements:"approved",document:"approved",documentHash:"a".repeat(64),approvedHash:"a".repeat(64),requiredParticipantIds:[id],contributions:[],confirmations:[id],reports:[{participantId:id,status:"passed",summary:"implementation",evidence:{},testFiles:[frozen]}],report:null}});
  const run=vi.spyOn(MockAgentAdapter.prototype,"run"),receipts:any[]=[];
  vi.spyOn(console,"log").mockImplementation(()=>{});vi.stubGlobal("fetch",vi.fn(async(url:string,options:any)=>{
   const body=JSON.parse(options.body);if(url.endsWith("/poll"))return Response.json({job:{id:crypto.randomUUID(),agentId:config.agentId,collaborationId:context.collaborationId,kind:"collaboration.turn",attempts:1,payload:{context}}});
   if(url.endsWith("/complete"))receipts.push(body);return Response.json({ok:true,...(body.activeJob?{jobState:{cancelRequested:false,leaseUntil:new Date(Date.now()+1200000).toISOString()}}:{})});
  }));
  await runConnector(config);expect(run).not.toHaveBeenCalled();expect(receipts).toHaveLength(1);expect(receipts[0].result.agentTurn.actions[0]).toMatchObject({type:"workflow.blocked",requiresReview:true,category:"code"});await expect(readFile(join(root,"executed.marker"))).rejects.toMatchObject({code:"ENOENT"});
 });
 it.each(["executing","joint_verifying","cached"])("%s已有批准也只查资料，不运行本机测试，不因旧工作区基线拒绝信息任务",async variant=>{
  const phase=variant==="cached"?"planning":variant;
  const git=(...args:string[])=>execFileSync("git",args,{cwd:root,stdio:"pipe"});
  await writeFile(join(root,"README.md"),"existing project");git("init","--quiet");git("add","README.md");git("-c","user.name=Fixture","-c","user.email=test@seam.test","commit","--quiet","-m","fixture");const planned=await workspaceBaseline(root);
  await writeFile(join(root,"README.md"),"changed facts remain readable");
  vi.stubEnv("SEAM_TEST_COMMAND",'node -e \'require("node:fs").writeFileSync("executed.marker","should not run")\'');
  const config=readConfig(["--once"],{SEAM_AGENT_ID:crypto.randomUUID(),SEAM_AGENT_TOKEN:"test-only",SEAM_PROJECT_ROOT:root});config.stateDir=join(root,"state");config.workspaceLockDir=join(root,"locks");
  const id=crypto.randomUUID(),requestId=crypto.randomUUID(),context=collaborationContextSchema.parse({collaborationId:crypto.randomUUID(),title:"只读查找",type:"custom",status:"in_progress",objective:"查协议事实",informationTask:{requestId,mode:"peer"},participant:{id,projectId:crypto.randomUUID(),projectName:"provider",agentId:config.agentId,agentName:"mock",role:"provider",approvalRequired:true,status:"active"},participants:[],messages:[],artifacts:[],workItems:[],lifecycle:{revision:1,phase,requirements:"原要求",document:"已批准文档",documentHash:"a".repeat(64),approvedHash:"a".repeat(64),requiredParticipantIds:[id],contributions:[{participantId:id,content:"本方分析",baseline:planned}],confirmations:[id],reports:[],report:null}});
  if(variant==="cached") {
   context.informationTask!.mode="verify";
   context.lifecycle!.informationRequests=[{id:requestId,revision:1,phase,key:"protocol",question:"读取本方已有公开事实",requestedByParticipantId:id,targetParticipantIds:[id],stage:"verify",status:"pending",answer:null,createdAt:new Date().toISOString(),responses:[],cachedFactKey:"protocol"}];
   context.lifecycle!.facts=[{key:"protocol",question:"protocol",value:"v1",answer:"缓存有效",revision:1,status:"active",confirmedAt:new Date().toISOString(),validUntil:new Date(Date.now()+60000).toISOString(),responses:[{participantId:id,mode:"peer",status:"found",answer:"缓存有效",sources:[{scope:"local_project",reference:"README.md",finding:"公开说明",contentHash:(await hashProjectFile(root,"README.md"))!}]}]}];
  }
  const run=vi.spyOn(MockAgentAdapter.prototype,"run").mockImplementation(async input=>{
   expect(input.context!.localDiscovery!.files).toContain("README.md");expect(input.context!.informationTask).toEqual({requestId,mode:"peer"});
   return {message:"显式合成的Connector机制单测，不是真实模型查找",kind:"status",actions:[{type:"information.respond",revision:1,requestId,status:"found",answer:"仅返回已读的合成测试事实",sources:[{scope:"local_project",reference:"README.md",finding:"只读机制测试夹具"}]}],notifyParticipantIds:[],needsHumanInput:false};
  });
  const receipts:any[]=[];vi.spyOn(console,"log").mockImplementation(()=>{});vi.spyOn(console,"error").mockImplementation(()=>{});
  vi.stubGlobal("fetch",vi.fn(async(url:string,options:any)=>{
   const body=JSON.parse(options.body);
   if(url.endsWith("/poll")){expect(body.supportsInformationLookup).toBe(true);return Response.json({job:{id:crypto.randomUUID(),agentId:config.agentId,collaborationId:context.collaborationId,kind:"collaboration.turn",attempts:1,payload:{context}}});}
   if(url.endsWith("/complete"))receipts.push(body);
   return Response.json({ok:true,...(body.activeJob?{jobState:{cancelRequested:false,leaseUntil:new Date(Date.now()+1200000).toISOString()}}:{})});
  }));
  await runConnector(config);expect(run).toHaveBeenCalledTimes(variant==="cached"?0:1);expect(receipts).toHaveLength(1);expect(receipts[0]).toMatchObject({status:"completed",result:{agentTurn:{actions:[{type:"information.respond"}]}}});
  await expect(readFile(join(root,"executed.marker"))).rejects.toMatchObject({code:"ENOENT"});expect(await readFile(join(root,"README.md"),"utf8")).toBe("changed facts remain readable");
 });
});
