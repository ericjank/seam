import {describe,expect,it} from "vitest";
import {readsHandoffResource} from "../src/resource-usage";
import {mkdtemp,mkdir,realpath,rm,symlink} from "node:fs/promises";
import {join} from "node:path";
import {tmpdir} from "node:os";

describe("资源读取计数",()=>{
 it("项目cwd已规范化但资源目录仍是符号别名时也识别相对读取",async()=>{
  const root=await mkdtemp(join(tmpdir(),"seam-resource-alias-"));
  try {
   await mkdir(join(root,"actual"));await mkdir(join(root,"actual/consumer"));await mkdir(join(root,"actual/resources"));await symlink(join(root,"actual"),join(root,"alias"));
   const cwd=await realpath(join(root,"actual/consumer")),resources=join(root,"alias/resources");
   expect(readsHandoffResource("cat ../resources/key.txt",cwd,resources)).toBe(true);
   expect(readsHandoffResource(`cat ${resources}/key.txt`,cwd,resources)).toBe(true);
  } finally {await rm(root,{recursive:true,force:true});}
 });
 it("绝对及相对目录、Python读取和转义空格都归入资源读取",()=>{
  const project="/tmp/seam/consumer",resources="/tmp/seam/codex-state/resources";
  expect(readsHandoffResource("cat /tmp/seam/codex-state/resources/key.txt",project,resources)).toBe(true);
  expect(readsHandoffResource('python3 -c \'Path("../codex-state/resources/key.txt").read_bytes()\'',project,resources)).toBe(true);
  expect(readsHandoffResource('python3 -c \'Path("../codex-state/resources/key.txt").read_text()\'',project,resources)).toBe(true);
  expect(readsHandoffResource('cat /tmp/seam\\ task/codex-state/resources/key.txt',"/tmp/seam task/consumer","/tmp/seam task/codex-state/resources")).toBe(true);
 });
 it("只打印资源路径或读取其他文件不算资源读取",()=>{
  expect(readsHandoffResource("echo /tmp/state/resources/key.txt","/tmp/project","/tmp/state/resources")).toBe(false);
  expect(readsHandoffResource("cat README.md","/tmp/project","/tmp/state/resources")).toBe(false);
 });
});
