#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { copyFile, mkdir, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

// Offline supplementary regression only: no center, model, or historical writes.
const exec = promisify(execFile);
const flags = new Map();
for (let index = 2; index < process.argv.length; index += 2) {
  assert.ok(process.argv[index]?.startsWith("--") && process.argv[index + 1], "use --historical-provider <file> --consumer <file> --evidence-dir <directory>");
  flags.set(process.argv[index].slice(2), process.argv[index + 1]);
}
for (const key of ["historical-provider", "consumer", "evidence-dir"]) assert.ok(flags.has(key), `missing --${key}`);
const historicalPath = await realpath(flags.get("historical-provider"));
const consumerPath = await realpath(flags.get("consumer"));
const fixtureRoot = dirname(dirname(historicalPath));
assert.match(fixtureRoot, /\/seam-full-simulation-[^/]+$/, "historical source must be an isolated simulation fixture");
assert.equal(historicalPath, join(fixtureRoot, "provider/service.mjs"));
assert.equal(consumerPath, join(fixtureRoot, "consumer/client.mjs"));
const output = resolve(flags.get("evidence-dir"));
assert.ok(output !== fixtureRoot && !output.startsWith(`${fixtureRoot}/`), "do not write evidence into the historical fixture");
await mkdir(output, { recursive: true });
const hash = (data) => createHash("sha256").update(data).digest("hex");
const before = { provider: hash(await readFile(historicalPath)), consumer: hash(await readFile(consumerPath)) };
const project = await mkdtemp(join(tmpdir(), "seam-discount-boundary-"));
await writeFile(join(project, "README.md"), "# 新建隔离合成边界回归\n仅生成虚拟提供方，测试默认折扣及非法类型。不是第三轮真实 Codex 验收；禁止访问中心或模型。\n");
const document = "隔离合成补充回归：discountPercent只有省略/undefined默认0，显式null、布尔、字符串、小数和越界值必须拒绝；不是第三轮真实Codex验收。";
const documentHash = hash(document);
const context = {
  syntheticBoundaryRegression: true, title: "隔离合成折扣边界回归", jobId: randomUUID(), collaborationId: randomUUID(),
  participant: { id: randomUUID(), projectName: "新建虚拟提供方", role: "provider" },
  lifecycle: { revision: 2, phase: "executing", requirements: document, document, documentHash, approvedHash: documentHash, contributions: [], confirmations: [], reports: [] },
};
await writeFile(join(output, "generation-context.json"), `${JSON.stringify(context, null, 2)}\n`);
const generator = join(dirname(fileURLToPath(import.meta.url)), "virtual-agent.mjs");
const generationStart = new Date().toISOString();
const generated = await exec(process.execPath, [generator, `协作上下文：${JSON.stringify(context)}`], { cwd: project, timeout: 30_000, maxBuffer: 1024 * 1024 });
await writeFile(join(output, "generation.stdout.txt"), generated.stdout);
await writeFile(join(output, "generation.stderr.txt"), generated.stderr);
await writeFile(join(output, "generation.json"), `${JSON.stringify({ evidenceType: "supplementary-boundary-regression", isThirdRealCodexAcceptance: false, modelCalls: 0, startedAtUtc: generationStart, endedAtUtc: new Date().toISOString(), executable: process.execPath, nodeVersion: process.version, command: "node scripts/simulation/virtual-agent.mjs <synthetic context from generation-context.json prefixed with 协作上下文：>", contextFile: "generation-context.json", workingDirectory: "[NEW_SYNTHETIC_PROVIDER]", exitCode: 0 }, null, 2)}\n`);
const receipt = JSON.parse(generated.stdout);
assert.ok(receipt.actions.some((action) => action.type === "execution.report" && action.status === "passed"));
const testStart = new Date().toISOString();
const tests = await exec(process.execPath, ["--test", "service.test.mjs"], { cwd: project, timeout: 30_000 });
await writeFile(join(output, "generated-provider-test.stdout.txt"), tests.stdout);
await writeFile(join(output, "generated-provider-test.stderr.txt"), tests.stderr);
await writeFile(join(output, "generated-provider-test.json"), `${JSON.stringify({ evidenceType: "supplementary-boundary-regression", isThirdRealCodexAcceptance: false, startedAtUtc: testStart, endedAtUtc: new Date().toISOString(), executable: process.execPath, nodeVersion: process.version, arguments: ["--test", "service.test.mjs"], command: "node --test service.test.mjs", workingDirectory: "[NEW_SYNTHETIC_PROVIDER]", exitCode: 0 }, null, 2)}\n`);
await mkdir(join(output, "generated-provider"), { recursive: true });
for (const file of ["service.mjs", "service.test.mjs"]) await copyFile(join(project, file), join(output, "generated-provider", file));

const historical = await import(pathToFileURL(historicalPath).href);
const fixed = await import(pathToFileURL(join(project, "service.mjs")).href);
const consumer = await import(pathToFileURL(consumerPath).href);
async function serve(quote, operation) {
  const requests = [];
  const server = createServer(async (request, response) => {
    assert.equal(request.method, "POST"); assert.equal(request.url, "/quote");
    let text = "";
    for await (const chunk of request) text += chunk;
    const input = JSON.parse(text);
    let status = 200;
    let body;
    try { body = quote(input); } catch (error) { status = 400; body = { error: error.message }; }
    requests.push({ input, status, body });
    response.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
  });
  await new Promise((resolveListen, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolveListen); });
  try { return await operation(`http://127.0.0.1:${server.address().port}`, requests); }
  finally { server.closeAllConnections(); await new Promise((resolveClose, reject) => server.close((error) => error ? reject(error) : resolveClose())); }
}
console.log("TAP version 13");
const original = await serve(historical.quote, async (base, requests) => {
  const input = { sku: "SKU-001", quantity: 1, discountPercent: null };
  const response = await consumer.getQuote(base, input);
  assert.equal(requests.at(-1).status, 200, "the historical bug should be reproduced, not concealed");
  assert.equal(response.discount, 0);
  return { evidenceType: "new-reproduction-of-historical-source", expectedContractHttpStatus: 400, actualHttpStatus: 200, contractViolationReproduced: true, input, response, requests };
});
await writeFile(join(output, "historical-null-reproduction.json"), `${JSON.stringify(original, null, 2)}\n`);
console.log("ok 1 - historical explicit null is wrongly accepted as HTTP 200 (known gap reproduced)");
const cases = [
  { name: "omitted", supplied: false, status: 200 },
  ...[0, 10, 100].map((value) => ({ name: `valid ${value}`, supplied: true, value, status: 200 })),
  ...[null, false, true, "10", 1.5, -1, 101].map((value) => ({ name: `invalid ${JSON.stringify(value)}`, supplied: true, value, status: 400 })),
];
const result = await serve(fixed.quote, async (base, requests) => {
  for (const [index, test] of cases.entries()) {
    const input = { sku: "SKU-001", quantity: 2, ...(test.supplied ? { discountPercent: test.value } : {}) };
    if (test.status === 400) await assert.rejects(() => consumer.getQuote(base, input), /HTTP 400/);
    else {
      const response = await consumer.getQuote(base, input);
      const discount = Math.floor(24000 * (test.value ?? 0) / 100);
      assert.equal(response.discount, discount); assert.equal(response.total, 24000 - discount);
    }
    assert.equal(requests.at(-1).status, test.status);
    console.log(`ok ${index + 2} - new generated provider ${test.name} reaches HTTP ${test.status} through historical real client`);
  }
  assert.equal(requests.length, cases.length);
  return { evidenceType: "supplementary-boundary-regression", isThirdRealCodexAcceptance: false, status: "passed", transport: "real localhost HTTP through historical consumer client", modelCalls: 0, caseCount: cases.length, receivedRequests: requests.length, requests };
});
assert.deepEqual({ provider: hash(await readFile(historicalPath)), consumer: hash(await readFile(consumerPath)) }, before, "historical source must stay unchanged");
await writeFile(join(output, "result.json"), `${JSON.stringify({ ...result, originalHistoricalFilesUnchanged: true, historicalSourceSha256: before, historicalNullReproduction: { expected: 400, actual: 200 } }, null, 2)}\n`);
console.log(`1..${cases.length + 1}\n# tests ${cases.length + 1}\n# pass ${cases.length + 1}\n# fail 0`);
