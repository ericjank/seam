#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { jointFixture } from "./joint-fixture.mjs";
import { providerServerSource } from "./provider-server.mjs";
import { promisify } from "node:util";

const exec = promisify(execFile);
const prompt = process.argv.at(-1) ?? "";
const marker = "协作上下文：";
const resource = prompt.match(/协作上下文文件：([^\n]+)/)?.[1];
assert.ok(resource || prompt.includes(marker), "virtual endpoint requires a real Connector context");
const context = JSON.parse(resource ? await readFile(resource.trim(), "utf8") : prompt.slice(prompt.lastIndexOf(marker) + marker.length));
const statePath = join(process.env.SEAM_MOCK_STATE_DIR, `${context.collaborationId}.json`);
let serviceState; try { serviceState = JSON.parse(await readFile(statePath, "utf8")); } catch {}
const lifecycle = context.lifecycle;
const actions = [];
let message = "虚拟提供方已读取本轮上下文，无需重复执行。";
let needsHumanInput = false;

if (!lifecycle) {
  message = "本次模拟要求受控生命周期，缺失时不会修改文件。";
  needsHumanInput = true;
} else if (lifecycle.phase === "planning" && !lifecycle.contributions.some((item) => item.participantId === context.participant.id)) {
  actions.push({ type: "plan.submit", revision: lifecycle.revision, content: `# 提供方完整实施方案（修订${lifecycle.revision}）

## 目标与范围
按README的合成报价HTTP契约提供POST /quote业务处理，单价均使用整数分，保留SKU-001与SKU-002。修改本项目service.mjs、server.mjs、service.test.mjs及获批后新建joint.test.mjs，不操作真实业务或部署环境。

## 接口与职责
导出quote(input)同步函数，由本项目server.mjs启动真实HTTP服务，service.publish发布经本机健康探测的动态地址。消费方client.mjs发起JSON请求并处理非2xx。quantity校验1至100整数，未知SKU返回明确错误。${lifecycle.revision >= 2 ? "本修订增加discountPercent整数0至100、discount和total，保留原字段及默认零折扣兼容行为。" : "本修订仅实施基础报价，折扣属于将来新增需求，不提前实现。"}

## 实施顺序与审批
双方先提交方案并确认共同文档的同一个hash；只在管理员批准当前修订后创建或修改代码，历史授权不适用于新修订。文档与approvedHash不匹配时停止实施。

## 测试与验收
使用Node内置node:test验证正常两SKU、边界和无效quantity，${lifecycle.revision >= 2 ? "补充0、10、100和无效discountPercent。" : "确认响应金额与CNY币种。"}实施后真实运行node --test service.test.mjs，输出退出码与命令证据；平台派发joint_verifying后运行node --test joint.test.mjs，逐项检查完整响应、两SKU、数量边界、错误与当前修订折扣。外部模拟器还会独立复核，不能替代平台内建联测。没有运行测试不得报告passed。

## 本次要求
${lifecycle.requirements}` });
  message = "提供方已提交当前修订的完整实施与测试方案，等待共同文档。";
} else if (lifecycle.phase === "plan_synthesis") {
  const ids = lifecycle.requiredParticipantIds;
  actions.push({ type: "plan.compose", revision: lifecycle.revision, baseDocumentHash: lifecycle.documentHash, contract: {
    scope: "在合成项目中实现并真实联合验证报价 HTTP 契约；服务代码由各端负责，服务进程由提供方实施并发布，缺失联合脚本由双方各自创建。",
    interfaces: [{ id: "quote", definition: "POST /quote 使用 JSON。SKU-001 单价12000分，SKU-002单价4500分；quantity为1到100整数，非法请求返回400。响应保留sku、quantity、subtotal和CNY币种。" + (lifecycle.revision >= 2 ? "discountPercent为0到100整数，省略默认0，null和布尔非法；discount向下取整，total=subtotal-discount。" : "") }],
    responsibilities: ids.map((participantId) => ({ participantId, changes: "读取本项目README并完成本方业务导出和Node单元测试；批准后实施，在批准后分别创建各自缺失的joint.test.mjs，再对提供方发布的就绪服务执行真实联合验证。" })),
    acceptanceCases: ids.map((runnerParticipantId, index) => ({ id: `joint-${index+1}`, runnerParticipantId, description: "运行本项目真实HTTP联合用例，验证正常报价及非法数量和本修订边界", command: "node --test joint.test.mjs", expectedResult: "退出码0，金额正确，非法输入HTTP400" })),
    risks: "仅本地合成项目；网络不可用如实报告未执行，不部署，不安装依赖。", changeSummary: lifecycle.revision >= 2 ? "保留基础报价，增量增加折扣字段和兼容验证。" : "首次统一字段、错误语义、双方职责及真实联合验收。", impactedParticipantIds: ids, retainedDecisions: lifecycle.revision >= 2 ? ["保留报价路径、SKU单价和数量校验"] : [],
  } });
  message = "虚拟协调方汇总统一契约，等待双方审阅。";
} else if (lifecycle.phase === "plan_confirmation" && !lifecycle.confirmations.includes(context.participant.id)) {
  assert.ok(lifecycle.document && lifecycle.documentHash, "confirmation requires the full shared document and hash");
  const definitions = lifecycle.contract.interfaces.map((item) => item.definition).join("\n");
  if (!/ready/i.test(definitions) || !/revision/i.test(definitions)) {
    actions.push({ type: "plan.reject", revision: lifecycle.revision, documentHash: lifecycle.documentHash,
      reason: "提供方审阅发现就绪语义缺漏：本地服务延迟启动，GET /health 必须返回200及 {ready:true,revision:当前修订}；共同接口契约需写明这两个字段，消费者从service.publish发现地址并先验证本轮revision，再运行联合测试，不能固定sleep或沿用旧服务。双方须在获批实施阶段各自创建缺失的joint.test.mjs。请补齐后重新确认。" });
    message = "提供方提出服务就绪与修订隔离的具体异议，等待协调方修订完整契约。";
  } else {
    actions.push({ type: "plan.confirm", revision: lifecycle.revision, documentHash: lifecycle.documentHash });
    message = "提供方已核对就绪语义、脚本责任及当前完整文档hash，确认本版。";
  }
} else if (lifecycle.phase === "executing" && !lifecycle.reports.some((item) => item.participantId === context.participant.id)) {
  assert.equal(lifecycle.approvedHash, lifecycle.documentHash, "virtual endpoint refuses writes without the current approved snapshot");
  const supportsDiscount = lifecycle.revision >= 2;
  const source = `const prices = {"SKU-001":12000,"SKU-002":4500};
export function quote(input) {
  if (!input || !Object.hasOwn(prices, input.sku)) throw new Error("unknown sku");
  if (!Number.isInteger(input.quantity) || input.quantity < 1 || input.quantity > 100) throw new Error("invalid quantity");
  const subtotal = prices[input.sku] * input.quantity;
  const output = {sku: input.sku, quantity: input.quantity, subtotal, currency:"CNY"};
  ${supportsDiscount ? `const percent = input.discountPercent === undefined ? 0 : input.discountPercent;
  if (!Number.isInteger(percent) || percent < 0 || percent > 100) throw new Error("invalid discountPercent");
  output.discount = Math.floor(subtotal * percent / 100);
  output.total = subtotal - output.discount;` : ""}
  return output;
}
`;
  const test = `import assert from "node:assert/strict";
import { test } from "node:test";
import { quote } from "./service.mjs";
test("normal prices and quantities", () => {
  assert.equal(quote({sku:"SKU-001",quantity:2}).subtotal,24000);
  assert.equal(quote({sku:"SKU-002",quantity:3}).subtotal,13500);
  assert.equal(quote({sku:"SKU-001",quantity:1}).currency,"CNY");
});
test("invalid inputs fail", () => {
  for(const quantity of [0,101,1.5,"2"]) assert.throws(() => quote({sku:"SKU-001",quantity}));
  assert.throws(() => quote({sku:"unknown",quantity:1}));
});
${supportsDiscount ? `test("discount boundaries and validation", () => {
  assert.equal(quote({sku:"SKU-001",quantity:2}).total,24000);
  assert.equal(quote({sku:"SKU-001",quantity:2,discountPercent:undefined}).discount,0);
  assert.equal(quote({sku:"SKU-001",quantity:2,discountPercent:10}).total,21600);
  assert.equal(quote({sku:"SKU-001",quantity:2,discountPercent:0}).discount,0);
  assert.equal(quote({sku:"SKU-001",quantity:2,discountPercent:100}).total,0);
  for (const discountPercent of [-1,101,1.5,"10",null,false,true,""]) assert.throws(() => quote({sku:"SKU-001",quantity:1,discountPercent}));
});` : ""}
`;
  await writeFile("service.mjs", source);
  await writeFile("service.test.mjs", test);
  const serverSource = providerServerSource(lifecycle.revision);
  if (serviceState?.revision !== lifecycle.revision) {
    if(serviceState?.pid) try {process.kill(serviceState.pid,"SIGTERM");} catch {}
    await writeFile("server.mjs", serverSource);
    const child=spawn(process.execPath,["server.mjs",statePath],{cwd:process.cwd(),detached:true,stdio:"ignore"}); child.unref();
    for(let attempt=0;attempt<50;attempt++) {try {const state=JSON.parse(await readFile(statePath,"utf8"));if(state.revision===lifecycle.revision){serviceState=state;break;}} catch {} await new Promise(resolve=>setTimeout(resolve,50));}
    assert.equal(serviceState?.revision,lifecycle.revision,"owned server must publish its actual address");
    await writeFile("joint.test.mjs",jointFixture({liveURL:serviceState.baseUrl,role:"provider",revision:lifecycle.revision}));
    actions.push({type:"workflow.blocked",revision:lifecycle.revision,kind:"retryable",reason:"本方实施已落盘，真实服务进程正在延迟启动，等待实际健康探测通过后发布；不重复创建服务。",dependencyParticipantIds:[],retryAfterSeconds:5});
    message="提供方保留已完成修改，等待本机服务就绪后续接同一批准版本。";
  } else {
  const started = Date.now();
  let status = "passed";
  let output;
  let exitCode = 0;
  try { output = await exec(process.execPath, ["--test", "service.test.mjs"], { cwd: process.cwd(), timeout: 30_000 }); }
  catch (error) { status = "failed"; exitCode = typeof error.code === "number" ? error.code : 1; output = error; }
  const health=await fetch(serviceState.baseUrl+"/health"); assert.equal(health.status,200);
  assert.deepEqual(await health.json(),{ready:true,revision:lifecycle.revision});
  actions.push({type:"service.publish",revision:lifecycle.revision,name:"quote",baseUrl:serviceState.baseUrl,healthPath:"/health",ttlSeconds:3600});
  actions.push({ type: "execution.report", revision: lifecycle.revision, status,
    summary: `提供方修订${lifecycle.revision}代码已落盘，Node合成测试${status === "passed" ? "通过" : "失败"}；未部署。`,
    evidence: { command: "node --test service.test.mjs", exitCode, durationMs: Date.now() - started,
      changedFiles: ["service.mjs", "service.test.mjs"], outputTail: `${output.stdout ?? ""}\n${output.stderr ?? ""}`.replaceAll(process.cwd(), "[project]").slice(-3000) },
  });
  message = `提供方当前批准修订已实施，并回传实际${status}测试证据。`;
  }
} else if (lifecycle.phase === "joint_verifying") {
  const run = lifecycle.evidenceRuns.filter((item) => item.participantId === context.participant.id && item.command === "node --test joint.test.mjs").at(-1);
  assert.ok(run, "Connector must execute the locally configured test command and capture raw output independently of the virtual Agent");
  actions.push({ type:"integration.report",revision:lifecycle.revision,documentHash:lifecycle.documentHash,
    checks:lifecycle.contract.acceptanceCases.filter(item=>item.runnerParticipantId===context.participant.id).map(item=>({caseId:item.id,status:run.exitCode===0?"passed":"failed",command:item.command,summary:"提供方针对已发布真实服务执行本轮联合测试；原始记录由Connector自动采集。",assertionNames:run.assertions,evidence:{details:"断言与命令日志见关联Connector记录，每次运行仅存一份。"}}))});
  message="提供方已关联实际联合测试断言及Connector原始记录。";

}

console.log(JSON.stringify({ message, kind: "status", actions, notifyParticipantIds: [], needsHumanInput }));
