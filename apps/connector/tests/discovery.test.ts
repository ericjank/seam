import {mkdtemp,mkdir,writeFile,symlink,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {afterEach,beforeEach,describe,expect,it} from "vitest";
import {discoverProject} from "../src/discovery";
let root:string;
beforeEach(async()=>{root=await mkdtemp(join(tmpdir(),"seam-discovery-"));});
afterEach(async()=>{await rm(root,{recursive:true,force:true});});
describe("本机自动资料索引",()=>{
 it("只读发现资料与测试入口，忽略秘密、依赖目录和符号链接",async()=>{
  await mkdir(join(root,"docs"));await writeFile(join(root,"docs/api.md"),"只在本机保留的接口原文");await writeFile(join(root,".env"),"SECRET=must-not-read");await writeFile(join(root,"private.key"),"secret");await mkdir(join(root,"node_modules"));await writeFile(join(root,"node_modules/no.txt"),"dependency");await symlink("/private",join(root,"external"));
  await writeFile(join(root,"package.json"),JSON.stringify({scripts:{test:"node --test",start:"node server.mjs"}}));
  const result=await discoverProject(root);expect(result.files).toEqual(["package.json","docs/api.md"]);expect(result.testCommands).toEqual(["test: node --test"]);expect(JSON.stringify(result)).not.toContain("接口原文");
 });
 it("资料索引有界，优先保留根目录README；非法manifest不阻断查找",async()=>{
  await writeFile(join(root,"README.md"),"existing context");await writeFile(join(root,"package.json"),"null");await mkdir(join(root,"a"));for(let i=0;i<120;i++)await writeFile(join(root,"a",`${i}.txt`),"fixture");
  const result=await discoverProject(root);expect(result.files).toContain("README.md");expect(result.files).toHaveLength(100);expect(result.testCommands).toEqual([]);
 });
});
