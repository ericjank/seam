import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { CONNECTOR_PROTOCOL_VERSION, expandSharedContract } from "../../packages/protocol/dist/index.js";
import { SimulationApi } from "./http.mjs";
import { launchOwned, processMatches, stopOwned } from "./owned-processes.mjs";

const exec = promisify(execFile);
const base = process.env.SEAM_SIMULATION_URL;
assert.ok(base, "Set SEAM_SIMULATION_URL to a dedicated, loopback Seam test installation");
assert.ok(!["", "3000", "13079"].includes(new URL(base).port), "Use an isolated installation and test database");
const api = new SimulationApi(base);
const suffix = randomUUID().slice(0, 8);
const runRoot = await mkdtemp(join(tmpdir(), "seam-bilateral-objections-"));
const entry = fileURLToPath(new URL("./connector-process.mjs", import.meta.url));
const reportPath = resolve(process.env.SEAM_BILATERAL_REPORT ?? join(runRoot, "report.json"));
const owned = [];
const peers = [];
const sha = bytes => createHash("sha256").update(bytes).digest("hex");
const progress = (event, fields = {}) => console.log(JSON.stringify({ event, ...fields }));
const readStatus = ({ root }) => exec("git", ["-C", root, "status", "--short", "--untracked-files=all"]).then(r => r.stdout);

async function loopbackPort() {
  const socket = createServer();
  await new Promise((resolve, reject) => {
    socket.once("error", reject);
    socket.listen(0, "127.0.0.1", resolve);
  });
  const { port } = socket.address();
  await new Promise((resolve, reject) => socket.close(error => error ? reject(error) : resolve()));
  return port;
}

const port = await loopbackPort();
const url = "http://127.0.0.1:" + port;
const marker = "seam-test-service-" + suffix;
const goal = [
  "在两个隔离项目实现并验收报价 HTTP 接口。消费方负责共同文档和 client.mjs，提供方负责 server.mjs。",
  "接口 ID 为 quote。健康 GET /health 返回 200 和 {ready:true}。POST /quote 收 JSON {sku:\"DEMO\",quantity:2}，返回 200 和 {subtotal:2400,currency:\"CNY\"}。quantity=0 返回 400 和 {error:\"invalid_quantity\"}。服务名 quote，JSON 响应须带 Content-Type application/json。",
  "两个 HTTP 要求用独立检查绑定。每端各一个用例，命令 node --test joint.test.mjs，必需断言名称固定为 quote success 和 invalid quantity。两端引用同样的成功和错误 HTTP 检查。错误正文要校验 error 精确值和非空字符串。用现有测试与 README，无依赖安装。",
  "这次要验收异议流程。协调方的首份草稿只在 interfaces.fields 中留出 response.body.error 这一个待补字段，HTTP 错误断言和其余规格仍须完整。审阅时由提供方提交一条绑定该字段的异议，责任方选提供方本身，补充字段约定后双方重新确认。实施前等待管理员批准。",
].join("\n");

const common = [
  "只操作本目录。这是独立的本机验收，README.md 给出完整协作目标。保留已提交的测试文件、运行脚本和断言。",
  "规划、异议处理和方案确认只读，使用 Seam 提供的结构化动作。获得该版实施批准后，创建本方实现文件，再实际运行 node --test unit.test.mjs。两个项目都有 unit.test.mjs 与 joint.test.mjs。联合测试由本机 Connector 配置执行。",
  "HTTP 请求和服务限定在本机验收端点。文件、命令和进程只用于本次隔离验收。",
].join("\n");
const providerRules = [
  "你是提供方。首个共同文档审阅时，如果 quote 接口缺少结构化字段 response.body.error，就用 plan.reject 绑定 quote / response.body.error，责任方选本方，恢复条件为声明无效数量时 error 固定为 invalid_quantity。HTTP 断言保持不动。收到该异议的独立派发时，用 plan.resolve 的 interface_field 修改补足这一字段。新文档满足条件后按当前哈希确认。",
  "实施时创建 server.mjs，导出同步函数 quote(input)，返回 {status,body}。仅在直接执行文件时绑定 127.0.0.1，端口取 QUOTE_PORT。POST /quote 使用 quote()，处理 JSON 和健康检查。单测通过后执行 node start-service.mjs，返回 execution.report 和 service.publish。baseUrl 为 " + url + "，healthPath=/health，name=quote，ttlSeconds=900。",
].join("\n");
const consumerRules = [
  "你是消费方及协调方。按任务约定生成第一份完整草稿，将 response.body.error 的结构化字段留给本次计划异议验证，独立 HTTP 检查仍覆盖该错误。审阅时可确认剩余范围，由提供方提交这条异议。",
  "实施时创建 client.mjs，导出异步 getQuote(baseUrl,input,fetcher=fetch)，发送 POST /quote JSON 并返回 {status,body}。保留实际 HTTP 错误响应状态和正文。运行本方单测并出实施回执，测试用的模拟 fetch 仅用于本地单测。",
].join("\n");

const check = 'import test from "node:test";\nimport assert from "node:assert/strict";\n';
const success = 'assert.deepEqual(result, { status: 200, body: { subtotal: 2400, currency: "CNY" } });';
const failure = 'assert.deepEqual(result, { status: 400, body: { error: "invalid_quantity" } });';
const jointCases = [
  'test("quote success", async () => { const result = await actual(2); ' + success + " });",
  'test("invalid quantity", async () => { const result = await actual(0); ' + failure + " });",
].join("\n");

async function seed(peer) {
  const provider = peer.role === "provider";
  await mkdir(peer.root);
  const unit = provider ? [
    'import { quote } from "./server.mjs";',
    'test("provider math", () => { const result = quote({sku:"DEMO",quantity:2}); ' + success + " });",
    'test("provider input boundary", () => { const result = quote({sku:"DEMO",quantity:0}); ' + failure + " });",
  ] : [
    'import { getQuote } from "./client.mjs";',
    'test("consumer JSON request", async () => {',
    '  const result = await getQuote("http://localhost", {sku:"DEMO",quantity:2}, async (url, request) => {',
    '    assert.equal(String(url), "http://localhost/quote"); assert.equal(request.method, "POST");',
    '    assert.deepEqual(JSON.parse(request.body), {sku:"DEMO",quantity:2});',
    '    return Response.json({subtotal:2400,currency:"CNY"});',
    '  }); ' + success + " });",
    'test("consumer exposes HTTP errors", async () => {',
    '  const result = await getQuote("http://localhost", {sku:"DEMO",quantity:0},',
    '    async () => Response.json({error:"invalid_quantity"}, {status:400})); ' + failure + " });",
  ];
  const joint = provider ? [
    'async function actual(quantity) {',
    '  const response = await fetch(process.env.SEAM_SERVICE_URL + "/quote", {method:"POST",',
    '    headers:{"content-type":"application/json"},body:JSON.stringify({sku:"DEMO",quantity})});',
    '  return {status:response.status,body:await response.json()};',
    '}',
  ] : [
    'import { getQuote } from "./client.mjs";',
    'const actual = quantity => getQuote(process.env.SEAM_SERVICE_URL, {sku:"DEMO",quantity});',
  ];
  await Promise.all([
    writeFile(join(peer.root, "README.md"), goal + "\n"),
    writeFile(join(peer.root, "AGENTS.md"), common + "\n" + (provider ? providerRules : consumerRules) + "\n"),
    writeFile(join(peer.root, "unit.test.mjs"), check + unit.join("\n") + "\n"),
    writeFile(join(peer.root, "joint.test.mjs"), check + joint.join("\n") + "\n" + jointCases + "\n"),
    writeFile(join(peer.root, ".gitignore"), ".run/\n"),
  ]);
  if (provider) await writeFile(join(peer.root, "start-service.mjs"), [
    'import { spawn } from "node:child_process";',
    'import { mkdir, open, writeFile } from "node:fs/promises";',
    'import { setTimeout as delay } from "node:timers/promises";',
    'const url = ' + JSON.stringify(url) + ';',
    'const healthy = () => fetch(url + "/health", {signal:AbortSignal.timeout(500)}).then(r=>r.ok).catch(()=>false);',
    'if (!await healthy()) {',
    '  await mkdir(".run", {recursive:true});',
    '  const log = await open(".run/service.log", "a");',
    '  const entry = new URL("./server.mjs", import.meta.url).pathname;',
    '  const marker = ' + JSON.stringify(marker) + ';',
    '  const child = spawn(process.execPath, [entry,marker], {detached:true,stdio:["ignore",log.fd,log.fd],',
    '    env:{PATH:process.env.PATH,QUOTE_PORT:' + JSON.stringify(String(port)) + '}});',
    '  await new Promise((resolve,reject)=>{child.once("spawn",resolve);child.once("error",reject);});',
    '  child.unref(); await log.close();',
    '  await writeFile(".run/process.json", JSON.stringify({pid:child.pid,entry,marker,detached:true}));',
    '  for(let attempt=0;attempt<40&&!await healthy();attempt++) await delay(150);',
    '}',
    'if (!await healthy()) throw new Error("provider health check did not pass");',
    'console.log(url);',
  ].join("\n"));
  await exec("git", ["init", "--quiet", peer.root]);
  await exec("git", ["-C", peer.root, "add", "."]);
  await exec("git", ["-C", peer.root, "-c", "user.name=Seam Acceptance", "-c", "user.email=acceptance@seam.test", "commit", "--quiet", "-m", "Seed protocol and tests before implementation"]);
}

async function waitFor(label, callback, timeout = 25 * 60_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const found = await callback();
    if (found) return found;
    await delay(1200);
  }
  throw new Error("Timed out waiting for " + label);
}

let id;
try {
  progress("bilateral-start", { runRoot, base, protocolVersion: CONNECTOR_PROTOCOL_VERSION });
  await api.call("/api/ready", undefined, { method: "GET" });
  await api.loginOwner();
  for (const role of ["consumer", "provider"]) {
    const registered = await api.register("bilateral-" + role + "-" + suffix, "codex-app-server");
    const peer = { ...registered, role, root: join(runRoot, role) };
    peers.push(peer);
    await seed(peer);
    const env = { ...process.env, SEAM_PLATFORM_URL: api.base, SEAM_PROJECT_ROOT: peer.root, SEAM_ADAPTER: "codex-app-server",
      SEAM_AGENT_ID: peer.agent.id, SEAM_AGENT_TOKEN: peer.agent.token, SEAM_CODEX_SANDBOX: "workspace-write", SEAM_CODEX_NETWORK_ACCESS: "true",
      SEAM_RUN_LABEL: "bilateral-" + suffix, SEAM_CONNECTOR_STATE_DIR: join(runRoot, role + "-journal"),
      SEAM_APP_SERVER_STATE_DIR: join(runRoot, role + "-sessions"), SEAM_WORKSPACE_LOCK_DIR: join(runRoot, "locks"), SEAM_TEST_COMMAND: "node --test joint.test.mjs" };
    owned.push(await launchOwned({ entry, env, logPath: join(runRoot, role + "-connector.log") }));
  }
  await waitFor("both real heartbeats", async () => {
    const { projects } = await api.call("/api/projects", undefined, { method: "GET" });
    return peers.every(peer => projects.some(row => row.agent?.id === peer.agent.id && row.agent.status === "online"));
  }, 45_000);
  const [consumer, provider] = peers;
  const created = await api.call("/api/collaborations", {
    title: "双真实 Agent · " + suffix, type: "api-integration", objective: goal,
    projectId: consumer.project.id, agentId: consumer.agent.id, targetProjectId: provider.project.id, targetAgentId: provider.agent.id,
  });
  id = created.id;
  assert.equal(created.jobs.length, 2);
  progress("collaboration-created", { id });
  const path = "/api/collaborations/" + id + "/lifecycle";
  await api.expect(path, { action: "approve", revision: 1, documentHash: "0".repeat(64) }, 409);
  let phase = "";
  const waitForPhase = wanted => waitFor(wanted, async () => {
    const current = await api.detail(id);
    if (phase !== current.lifecycle.phase) {
      phase = current.lifecycle.phase;
      progress("phase", { phase, revision: current.lifecycle.revision });
    }
    assert.equal(current.lifecycle.revision, 1, "unexpected repair or scope change");
    assert.equal(current.lifecycle.paused, false, "unexpected global pause");
    assert.ok(!current.lifecycle.planObjections?.some(row => row.state === "paused"), "an objection requires external evidence");
    return phase === wanted ? current : null;
  });
  const review = await waitForPhase("awaiting_approval");
  assert.equal(review.lifecycle.confirmations.length, 2);
  const [issue] = review.lifecycle.planObjections ?? [];
  assert.equal(issue?.target.path, "response.body.error");
  assert.equal(issue?.state, "addressed");
  assert.equal(issue?.response?.kind, "change");
  assert.notEqual(review.lifecycle.documentHash, issue.documentHash);
  assert.ok(review.lifecycle.document.includes("invalid_quantity"));
  assert.deepEqual(await Promise.all(peers.map(readStatus)), ["", ""], "both worktrees must be clean before approval");
  const approvedHash = review.lifecycle.documentHash;
  await api.lifecycle(id, { action: "approve", revision: 1, documentHash: approvedHash });
  const verified = await waitForPhase("awaiting_review");
  assert.equal(verified.lifecycle.approvedHash, approvedHash);
  assert.equal(verified.lifecycle.reports.length, 2);
  assert.equal(verified.lifecycle.integrationReports.length, 2);
  assert.ok(verified.lifecycle.reports.every(report => report.status === "passed"));
  assert.ok(verified.lifecycle.integrationReports.every(row => row.checks.length && row.checks.every(check => check.status === "passed" && check.runIds.length)));
  const independent = verified.lifecycle.reports.flatMap(row => row.evidence.independentResults ?? []);
  const approvedCases = expandSharedContract(review.lifecycle.contract).acceptanceCases;
  for (const item of approvedCases) {
    for (const status of [200, 400]) {
      assert.ok(item.httpChecks.some(check => check.method === "POST" && check.path === "/quote" && check.expectedStatus === status));
    }
  }
  const checkIds = approvedCases.flatMap(item => item.httpChecks.map(check => item.id + "/" + check.id));
  assert.deepEqual(independent.map(check => check.caseId + "/" + check.id).sort(), checkIds.sort());
  assert.ok(independent.every(result => result.status === "passed" && result.documentHash === approvedHash));
  const recordedPeers = [];
  for (const peer of peers) {
    const file = peer.role === "provider" ? "server.mjs" : "client.mjs";
    assert.equal((await readStatus(peer)).trim(), "?? " + file);
    const participantId = verified.participants.find(row => row.agent?.id === peer.agent.id).participant.id;
    const execution = verified.jobs.find(job => job.agentId === peer.agent.id && job.telemetry?.phase === "executing" && job.status === "completed");
    assert.equal(execution?.conversation?.transport, "codex-app-server");
    assert.ok(execution.telemetry?.turnId);
    assert.equal(execution.provenance.protocolVersion, CONNECTOR_PROTOCOL_VERSION);
    const runs = verified.lifecycle.evidenceRuns.filter(run => run.participantId === participantId);
    assert.ok(runs.some(run => run.source === "local-test" && run.command === "node --test joint.test.mjs" && run.exitCode === 0));
    // Verify the frozen unit tests independently. A model can include the same test
    // in a shell batch, whose surrounding output is not exported as command evidence.
    const unit = await exec(process.execPath, ["--test", "unit.test.mjs"], { cwd: peer.root });
    assert.match(unit.stdout, /^# pass 2$/m);
    assert.match(unit.stdout, /^# fail 0$/m);
    recordedPeers.push({ role: peer.role, participantId, changedFile: file, sha256: sha(await readFile(join(peer.root, file))),
      conversation: execution.conversation, implementationTurn: execution.telemetry.turnId, provenance: execution.provenance, runs,
      unitRecheck: { command: "node --test unit.test.mjs", exitCode: 0, output: unit.stdout } });
  }
  assert.notEqual(recordedPeers[0].conversation.threadId, recordedPeers[1].conversation.threadId);
  assert.equal(recordedPeers[0].provenance.platformSourceId, recordedPeers[1].provenance.platformSourceId);
  assert.equal(recordedPeers[0].provenance.connectorSourceId, recordedPeers[1].provenance.connectorSourceId);
  const sealed = await api.lifecycle(id, { action: "terminate", revision: 1, decision: "accepted", reportHash: verified.lifecycle.reportHash });
  assert.equal(sealed.lifecycle.finalDecision.outcome, "accepted");
  await mkdir(resolve(reportPath, ".."), { recursive: true });
  await writeFile(reportPath, JSON.stringify({
    collaborationId: id, approvedHash, preApprovalWorktreesClean: true,
    issue, peers: recordedPeers, phaseEvents: verified.lifecycleEvents, integrationReports: verified.lifecycle.integrationReports,
    independent, finalDecision: sealed.lifecycle.finalDecision,
  }, null, 2) + "\n");
  progress("bilateral-passed", { id, reportPath, independentCount: independent.length });
} catch (error) {
  if (id) {
    const snapshot = await api.detail(id).catch(() => null);
    progress("bilateral-failed", { id, phase: snapshot?.lifecycle?.phase,
      blocks: snapshot?.lifecycle?.blocks, objections: snapshot?.lifecycle?.planObjections,
      recentJobs: snapshot?.jobs.slice(0, 6).map(({ agentName, status, error, telemetry }) => ({ agentName, status, error, phase: telemetry?.phase })) });
    if (snapshot && !snapshot.lifecycle.paused && snapshot.lifecycle.phase !== "terminated") {
      await api.lifecycle(id, { action: "pause" }).catch(() => undefined);
    }
  }
  throw error;
} finally {
  const provider = peers.find(peer => peer.role === "provider");
  const service = provider && await readFile(join(provider.root, ".run/process.json"), "utf8").then(JSON.parse).catch(() => null);
  const records = service?.marker === marker ? [...owned, service] : owned;
  for (const record of records) await stopOwned(record);
  for (const record of records) await waitFor("process to exit", async () => !await processMatches(record), 12_000);
}
