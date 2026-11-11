#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { promisify } from "node:util";

const exec = promisify(execFile);
const prompt = process.argv.at(-1) ?? "";
const marker = "协作上下文：";
assert.ok(prompt.includes(marker), "virtual endpoint requires a real Connector context");
const context = JSON.parse(prompt.slice(prompt.lastIndexOf(marker) + marker.length));
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
按README的合成报价HTTP契约提供POST /quote业务处理，单价均使用整数分，保留SKU-001与SKU-002。只修改本项目service.mjs及service.test.mjs，不操作真实业务或部署环境。

## 接口与职责
导出quote(input)同步函数，由独立模拟HTTP网关绑定/quote。消费方client.mjs发起JSON请求并处理非2xx。quantity校验1至100整数，未知SKU返回明确错误。${lifecycle.revision >= 2 ? "本修订增加discountPercent整数0至100、discount和total，保留原字段及默认零折扣兼容行为。" : "本修订仅实施基础报价，折扣属于将来新增需求，不提前实现。"}

## 实施顺序与审批
双方先提交方案并确认共同文档的同一个hash；只在管理员批准当前修订后创建或修改代码，历史授权不适用于新修订。文档与approvedHash不匹配时停止实施。

## 测试与验收
使用Node内置node:test验证正常两SKU、边界和无效quantity，${lifecycle.revision >= 2 ? "补充0、10、100和无效discountPercent。" : "确认响应金额与CNY币种。"}实施后真实运行node --test service.test.mjs，输出退出码与命令证据；最终由模拟运行器连接消费方实施进行真实HTTP联合检查。没有运行测试不得报告passed。

## 本次要求
${lifecycle.requirements}` });
  message = "提供方已提交当前修订的完整实施与测试方案，等待共同文档。";
} else if (lifecycle.phase === "plan_confirmation" && !lifecycle.confirmations.includes(context.participant.id)) {
  assert.ok(lifecycle.document && lifecycle.documentHash, "confirmation requires the full shared document and hash");
  actions.push({ type: "plan.confirm", revision: lifecycle.revision, documentHash: lifecycle.documentHash });
  message = "提供方已阅读共同文档并确认当前revision/hash，等待管理员批准。";
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
  const started = Date.now();
  let status = "passed";
  let output;
  let exitCode = 0;
  try { output = await exec(process.execPath, ["--test", "service.test.mjs"], { cwd: process.cwd(), timeout: 30_000 }); }
  catch (error) { status = "failed"; exitCode = typeof error.code === "number" ? error.code : 1; output = error; }
  actions.push({ type: "execution.report", revision: lifecycle.revision, status,
    summary: `提供方修订${lifecycle.revision}代码已落盘，Node合成测试${status === "passed" ? "通过" : "失败"}；未部署。`,
    evidence: { command: "node --test service.test.mjs", exitCode, durationMs: Date.now() - started,
      changedFiles: ["service.mjs", "service.test.mjs"], outputTail: `${output.stdout ?? ""}\n${output.stderr ?? ""}`.replaceAll(process.cwd(), "[project]").slice(-3000) },
  });
  message = `提供方当前批准修订已实施，并回传实际${status}测试证据。`;
}

console.log(JSON.stringify({ message, kind: "status", actions, notifyParticipantIds: [], needsHumanInput }));
