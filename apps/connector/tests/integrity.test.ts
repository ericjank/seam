import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { collaborationContextSchema } from "@seam/protocol";
import { checkPinnedTests, collectTestFiles, fingerprintInformation, hashProjectFile, verifyCachedFact } from "../src/integrity";
let root: string;
beforeEach(async()=>{root=await mkdtemp(join(tmpdir(),"seam-integrity-"));});
afterEach(async()=>{await rm(root,{recursive:true,force:true});});

describe("实际测试资料与共享事实来源指纹",()=>{
 it("测试及验收数据一起固定，未批准的修改或删除拒绝，声明的变更可供重新批准",async()=>{
  await mkdir(join(root,"tests"));await writeFile(join(root,"client.test.mjs"),"test original logic");await writeFile(join(root,"tests/expected.json"),'{"subtotal":24000}');await writeFile(join(root,"service.mjs"),"business source");await writeFile(join(root,".env"),"PRIVATE=never-publish");
  const before=await collectTestFiles(root);expect(before.map(row=>row.path)).toEqual(["client.test.mjs","tests/expected.json"]);
  expect(()=>checkPinnedTests(before,[...before,{path:"new.test.mjs",sha256:"f".repeat(64)}],{participant:{id:"consumer"}} as any)).toThrow("新增");
  await writeFile(join(root,"client.test.mjs"),"same test name, weaker implementation");const after=await collectTestFiles(root);
  const context={participant:{id:"consumer"},lifecycle:{contract:{testChanges:[]}}} as any;
  expect(()=>checkPinnedTests(before,after,context)).toThrow("指纹");
  context.lifecycle.contract.testChanges=[{participantId:"consumer",path:"client.test.mjs",reason:"明确修订原测试数据，须重新批准"}];
  expect(()=>checkPinnedTests(before,after,context,true)).not.toThrow();
  expect(()=>checkPinnedTests(before,after,context,false)).toThrow("指纹");
  await rm(join(root,"tests/expected.json"));expect(()=>checkPinnedTests(before,after.filter(row=>row.path!=="tests/expected.json"),context)).toThrow();
 });
 it("资料哈希不能经绝对路径、秘密文件或符号链接逃出本项目",async()=>{
  await writeFile(join(root,"README.md"),"public fact");await writeFile(join(root,".env"),"secret");await symlink(join(root,"README.md"),join(root,"alias.test.mjs"));
  expect(await hashProjectFile(root,".env")).toBeNull();expect(await hashProjectFile(root,"../outside")).toBeNull();expect(await hashProjectFile(root,join(root,"README.md"))).toBeNull();expect(await hashProjectFile(root,"alias.test.mjs")).toBeNull();
  await expect(collectTestFiles(root)).rejects.toThrow("可核对");
 });
 it("来源哈希由Connector计算；跨修订缓存验证只读复用，文件变化后不能复用旧事实",async()=>{
  await writeFile(join(root,"protocol.json"),'{"version":"v1"}');const id=crypto.randomUUID(),requestId=crypto.randomUUID();
  const turn={message:"found",kind:"status",actions:[{type:"information.respond",revision:1,requestId,status:"found",answer:"version=v1",value:"v1",sources:[{scope:"local_project",reference:"protocol.json",finding:"当前公开版本",contentHash:"f".repeat(64)}]}],notifyParticipantIds:[],needsHumanInput:false} as any;
  await fingerprintInformation(turn,root);const source=turn.actions[0].sources[0];expect(source.contentHash).toBe(createHash("sha256").update(await readFile(join(root,"protocol.json"))).digest("hex"));
  const context=collaborationContextSchema.parse({collaborationId:crypto.randomUUID(),title:"cache",type:"custom",status:"in_progress",objective:"facts",participant:{id,projectId:crypto.randomUUID(),projectName:"provider",agentId:null,agentName:null,role:"provider",approvalRequired:true,status:"active"},participants:[],messages:[],artifacts:[],workItems:[],informationTask:{requestId,mode:"verify",attempt:1},lifecycle:{revision:2,phase:"planning",requirements:"reuse",document:null,documentHash:null,approvedHash:null,requiredParticipantIds:[id],contributions:[],confirmations:[],reports:[],report:null,informationRequests:[{id:requestId,revision:2,phase:"planning",question:"protocol version",key:"protocol.version",cachedFactKey:"protocol.version",createdAt:new Date().toISOString(),requestedByParticipantId:id,targetParticipantIds:[id],stage:"verify",status:"pending",answer:null,responses:[]}],facts:[{key:"protocol.version",question:"protocol version",value:"v1",answer:"version=v1",revision:1,status:"active",confirmedAt:new Date().toISOString(),validUntil:new Date(Date.now()+60000).toISOString(),responses:[{participantId:id,mode:"peer",status:"found",answer:"version=v1",sources:[source]}]}]}});
  expect((await verifyCachedFact(context,root))!.actions[0]).toMatchObject({type:"information.respond",status:"found",value:"v1"});
  await writeFile(join(root,"protocol.json"),'{"version":"v2"}');expect((await verifyCachedFact(context,root))!.actions[0]).toMatchObject({status:"unavailable"});
  expect(await readFile(join(root,"protocol.json"),"utf8")).toContain("v2");
 });
});
