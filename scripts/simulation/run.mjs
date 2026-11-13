#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { mkdtemp, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { SimulationApi } from "./http.mjs";
import { agentInstructions, contract, revisionOne, revisions } from "./contract.mjs";
import { publishJointEvidence } from "./publish-joint-evidence.mjs";

const exec = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const api = new SimulationApi();
const repairInformation = process.env.SEAM_SIMULATION_SCENARIO === "repair-information";
let contractVersion;
const checks = [];
let runRoot;
let collaborationId;
let locals = [];
const workers = [];

function lifecycle(detail) {
  const value = detail.lifecycle ?? detail.collaboration.lifecycle;
  assert.ok(value, "the local service must implement the controlled collaboration lifecycle");
  return value;
}

function progress(event, fields = {}) {
  console.log(JSON.stringify({ at: new Date().toISOString(), event, ...fields }));
}

async function snapshot(root, relative = "") {
  const files = {};
  for (const entry of await readdir(join(root, relative), { withFileTypes: true })) {
    if (entry.name === ".git") continue;
    const path = relative ? `${relative}/${entry.name}` : entry.name;
    if (entry.isDirectory()) Object.assign(files, await snapshot(root, path));
    else if (entry.isFile()) files[path] = createHash("sha256").update(await readFile(join(root, path))).digest("hex");
    else assert.fail(`unexpected nonregular project entry: ${path}`);
  }
  return files;
}

async function assertNoUnapprovedWrites(baseline) {
  for (const [index, local] of locals.entries()) {
    assert.deepEqual(await snapshot(local.root), baseline[index], `${local.role} wrote files before this revision was approved`);
  }
}

async function startConnectors(selected = locals) {
  for (const local of selected) {
    const env = { ...process.env, SEAM_PLATFORM_URL: api.base, SEAM_AGENT_ID: local.agent.id, SEAM_AGENT_TOKEN: local.agent.token,
      SEAM_PROJECT_ROOT: local.root, SEAM_ADAPTER: local.role === "consumer" ? "codex-app-server" : "generic-cli",
      SEAM_CODEX_SANDBOX: "workspace-write", SEAM_CODEX_NETWORK_ACCESS: "true",
      SEAM_CONNECTOR_STATE_DIR: join(runRoot, "connector-state"), SEAM_WORKSPACE_LOCK_DIR: join(runRoot, "workspace-locks"),
      SEAM_APP_SERVER_STATE_DIR: join(runRoot, "codex-state"), SEAM_MOCK_STATE_DIR: join(runRoot, "mock-state"),
      SEAM_POLL_INTERVAL_MS: "200", SEAM_RUN_LABEL: `验收-${runRoot.split("-").at(-1)}` };
    if (local.role === "provider") {
      env.SEAM_GENERIC_AGENT_COMMAND = process.execPath;
      env.SEAM_GENERIC_AGENT_ARGS = JSON.stringify([join(here, "virtual-agent.mjs")]);
      env.SEAM_TEST_COMMAND = "node --test joint.test.mjs";
    } else delete env.SEAM_TEST_COMMAND;
    const child = spawn(process.execPath, [join(here, "../../apps/connector/dist/cli.js")], { env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    const logs = [];
    child.stdout.on("data", (chunk) => logs.push(chunk.toString()));
    child.stderr.on("data", (chunk) => logs.push(chunk.toString()));
    child.on("exit", (code, signal) => { local.exit = { code, signal }; });
    workers.push({ child, local, logs });
  }
  progress("independent-connectors-started", { pids: workers.map(({child}) => child.pid) });
}

async function writeRunIndex(status, detail) {
  if(!runRoot)return;
  detail ??= collaborationId ? await api.detail(collaborationId) : null;
  const sessions=[...new Map((detail?.jobs??[]).filter(job=>job.conversation).toReversed().map(job=>[job.conversation.threadId,job.conversation])).values()];
  await writeFile(join(runRoot,"run-index.json"),JSON.stringify({at:new Date().toISOString(),runLabel:`验收-${runRoot.split("-").at(-1)}`,status,collaborationId,revision:detail?.lifecycle?.revision,phase:detail?.lifecycle?.phase,sessions:sessions.map(session=>({...session,url:`codex://threads/${session.threadId}`}))},null,2));
}
async function restartConsumerWithLostCheckpoint(){
  const index=workers.findIndex(worker=>worker.local.role==="consumer"),worker=workers[index];
  assert.ok(worker);
  const closed=new Promise(resolve=>worker.child.once("exit",resolve));
  process.kill(-worker.child.pid,"SIGTERM");await closed;
  await writeFile(join(runRoot,"consumer-connector-before-restart.log"),worker.logs.join(""));
  workers.splice(index,1);delete worker.local.exit;
  const directory=join(runRoot,"codex-state");
  const file=(await readdir(directory)).find(name=>name.endsWith(".json"));assert.ok(file);
  const path=join(directory,file),session=JSON.parse(await readFile(path,"utf8"));
  delete session.lastHandoff;await writeFile(path,JSON.stringify(session),{mode:0o600});
  await startConnectors([worker.local]);
  progress("connector-restarted",{threadId:session.threadId,checkpointReset:true,scope:"owned idle Connector; checkpoint loss, not claimed actual model compaction"});
  checks.push("修订3后重启本方Connector并模拟交接检查点丢失；保留同一thread，重新同步当前资料");
}

async function runUntilPhase(expected) {
  const deadline = Date.now() + 25 * 60_000;
  let previous;
  while (Date.now() < deadline) {
    const detail = await api.detail(collaborationId), current = lifecycle(detail);
    const state = JSON.stringify([current.revision, current.phase, detail.jobs.map((job) => [job.id, job.status]), current.blocks]);
    if (state !== previous) {
      progress("lifecycle", { revision: current.revision, phase: current.phase, jobs: detail.jobs.map((job) => ({id:job.id,status:job.status})), blocks: current.blocks });
      await writeFile(join(runRoot, `state-${Date.now()}.json`), JSON.stringify(detail, null, 2));
      previous = state;
      await writeRunIndex("running", detail);
    }
    if (current.phase === expected) return detail;
    assert.notEqual(current.phase, "terminated");
    const failed = detail.jobs.find((job) => job.status === "failed");
    assert.ok(!failed, `Connector failed: ${failed?.error ?? ""}`);
    assert.ok(!current.blocks.some((block) => block.kind === "needs_admin"), `unexpected administrator dependency: ${JSON.stringify(current.blocks)}`);
    assert.ok(workers.every(({local}) => !local.exit), "a long-running Connector exited unexpectedly");
    await new Promise((resolve) => setTimeout(resolve, 1500));
  }
  assert.fail(`did not reach ${expected} before deadline`);
}

async function jointHttpCheck(revision) {
  const businessRevision = repairInformation ? 1 : revision;
  const provider = await import(`${pathToFileURL(join(locals[0].root, "service.mjs"))}?revision=${revision}`);
  const consumer = await import(`${pathToFileURL(join(locals[1].root, "client.mjs"))}?revision=${revision}`);
  assert.equal(typeof provider.quote, "function", "provider must implement the approved quote export");
  assert.equal(typeof consumer.getQuote, "function", "the real AI must implement the approved consumer export");
  let received = 0;
  const server = createServer(async (request, response) => {
    if (request.method !== "POST" || request.url !== "/quote") {
      response.writeHead(404).end();
      return;
    }
    received += 1;
    try {
      let content = "";
      for await (const chunk of request) {
        content += chunk;
        if (content.length > 10_000) throw new Error("request too large");
      }
      const result = provider.quote(JSON.parse(content));
      response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(result));
    } catch (error) {
      response.writeHead(400, { "content-type": "application/json" }).end(JSON.stringify({ error: error.message }));
    }
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  try {
    const address = `http://127.0.0.1:${server.address().port}`;
    const normal = await consumer.getQuote(address, { sku: "SKU-001", quantity: 2 });
    assert.equal(normal.subtotal, 24000);
    assert.equal(normal.currency, "CNY");
    const second = await consumer.getQuote(address, { sku: "SKU-002", quantity: 3 });
    assert.equal(second.subtotal, 13500);
    await assert.rejects(() => consumer.getQuote(address, { sku: "SKU-001", quantity: 0 }));
    await assert.rejects(() => consumer.getQuote(address, { sku: "unknown", quantity: 1 }));
    // A consumer may reject bad inputs locally. Verify the provider's HTTP
    // errors independently so that both implementations are checked precisely.
    for (const input of [{ sku: "SKU-001", quantity: 0 }, { sku: "unknown", quantity: 1 }]) {
      const rejected = await fetch(`${address}/quote`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input) });
      assert.equal(rejected.status, 400);
    }
    const additionalInvalidDiscounts = [null, false, true, "10", 1.5, 101];
    if (businessRevision >= 2 && businessRevision <= 4) {
      const zeroDiscount = await consumer.getQuote(address, { sku: "SKU-001", quantity: 2, discountPercent: 0 });
      assert.equal(zeroDiscount.discount, 0);
      assert.equal(zeroDiscount.total, 24000);
      const discounted = await consumer.getQuote(address, { sku: "SKU-001", quantity: 2, discountPercent: 10 });
      assert.equal(discounted.discount, 2400);
      assert.equal(discounted.total, 21600);
      assert.equal((await consumer.getQuote(address, { sku: "SKU-001", quantity: 2, discountPercent: 100 })).total, 0);
      await assert.rejects(() => consumer.getQuote(address, { sku: "SKU-001", quantity: 1, discountPercent: -1 }));
      const rejectedDiscount = await fetch(`${address}/quote`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sku: "SKU-001", quantity: 1, discountPercent: -1 }) });
      assert.equal(rejectedDiscount.status, 400);
      for (const discountPercent of additionalInvalidDiscounts) {
        const input = { sku: "SKU-001", quantity: 1, discountPercent };
        await assert.rejects(() => consumer.getQuote(address, input));
        const invalid = await fetch(`${address}/quote`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input) });
        assert.equal(invalid.status, 400, `discountPercent=${JSON.stringify(discountPercent)} must fail at the provider`);
      }
    }
    for (const quantity of [50,51,100]) {
      const input={sku:"SKU-001",quantity};
      const response=await fetch(`${address}/quote`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(input)});
      if(businessRevision===3 && quantity>50){assert.equal(response.status,400);await assert.rejects(()=>consumer.getQuote(address,input));}
      else {assert.equal(response.status,200);assert.equal((await consumer.getQuote(address,input)).subtotal,12000*quantity);}
    }
    if(businessRevision===5){
      assert.deepEqual(Object.keys(normal).sort(),["currency","quantity","sku","subtotal"]);
      for(const discountPercent of [0,10,100,null,false]){
        const input={sku:"SKU-001",quantity:2,discountPercent};
        assert.equal((await fetch(`${address}/quote`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(input)})).status,400);
        await assert.rejects(()=>consumer.getQuote(address,input));
      }
    }
    // Consumer-side validation may avoid some calls. Each added invalid case
    // still has a direct provider HTTP check. Historical 6/10 counts belong
    // to their original reports; new executions record their actual counts.
    assert.ok(received >= (businessRevision >= 2 && businessRevision <= 4 ? 8 + additionalInvalidDiscounts.length : 4), "joint checks must reach the provider through real HTTP");
    return { revision, status: "passed", transport: "real localhost HTTP", receivedRequests: received };
  } finally {
    server.closeAllConnections();
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

async function approveAndExecute(detail, baseline) {
  const ready = lifecycle(detail);
  assert.equal(ready.phase, "awaiting_approval");
  assert.ok(ready.document && ready.document.length >= 100);
  assert.equal(new Set(ready.confirmations).size, 2, "both participants must confirm the same full document");
  await assertNoUnapprovedWrites(baseline);
  await writeFile(join(runRoot, `revision-${ready.revision}-approved-plan.md`), ready.document);
  await api.expect(`/api/collaborations/${collaborationId}/lifecycle`, {
    action: "approve", revision: ready.revision, documentHash: "0".repeat(64),
  }, 409);
  await assertNoUnapprovedWrites(baseline);
  await api.lifecycle(collaborationId, { action: "approve", revision: ready.revision, documentHash: ready.documentHash });
  const reviewed = await runUntilPhase("awaiting_review");
  const completed = lifecycle(reviewed);
  assert.equal(completed.reports.length, 2, "both endpoints must submit actual execution.report actions");
  assert.ok(completed.reports.every((report) => report.status === "passed"), "a failed test cannot be counted as a passed simulation");
  assert.equal(completed.integrationReports.length, 2);
  assert.ok(completed.integrationReports.every((entry) => entry.checks.every((check) => check.runIds.length && check.assertionNames.length)), "every passed case needs automatically captured command/assertion references");
  assert.ok(completed.services.some((service) => service.probe?.ok), "endpoint must be published by a project Connector after a real health probe");
  if (ready.revision === 1) progress("contract-review-result", { objections: completed.objections.length,
    scope: "Virtual peer rejects a concrete readiness omission when present. A complete initial contract is valid and must not be forced to contain a defect." });
  assert.ok(completed.integrationReports.every((entry) => entry.checks.every((check) => check.status === "passed")), "built-in joint verification must actually pass");
  assert.ok(completed.report, "Seam must produce the administrator's implementation report");
  const joint = await jointHttpCheck(ready.revision);
  await writeFile(join(runRoot, `revision-${ready.revision}-report.json`), JSON.stringify({ lifecycle: completed, joint }, null, 2));
  const jointPublication = await publishJointEvidence({ api, runRoot, collaborationId, revision: ready.revision });
  progress("joint-evidence-published", jointPublication);
  checks.push(`修订${ready.revision}：完整方案、双方同hash确认、批准前无文件写入、批准后双方实施/真实测试/报告及实际HTTP联合验证`);
  progress("revision-passed", joint);
  return reviewed;
}

async function main() {
  runRoot = await mkdtemp(join(tmpdir(), "seam-full-simulation-"));
  await mkdir(join(runRoot, "codex-state"));
  progress("simulation-started", { base: api.base, runRoot, ai: "real local Codex app-server", peer: "deterministic virtual provider" });
  await api.call("/api/health", undefined, { method: "GET" });
  await api.loginOwner();
  const suffix = randomUUID().slice(0, 8);
  if (repairInformation) contractVersion = `public-quote-${randomUUID().slice(0, 8)}`;
  for (const [role, adapter] of [["provider", "generic-cli"], ["consumer", "codex-app-server"]]) {
    const registered = await api.register(`simulation-${role}-${suffix}`, adapter);
    const root = join(runRoot, role);
    await mkdir(root);
    await writeFile(join(root, "README.md"), `${contract}\n\n本项目职责：${role === "provider" ? "提供方" : "消费方"}。\n`);
    await writeFile(join(root, "AGENTS.md"), agentInstructions);
    if (repairInformation) {
      await writeFile(join(root, "README.md"), `${contract}\n\n本项目职责：${role}。服务的额外公开就绪字段contractVersion必须符合提供方现有项目文档；缺少时先查本地和共享资料，再自动询证，不由管理员填写。\n`);
      await writeFile(join(root, "AGENTS.md"), `${agentInstructions}\n本次只实现基础报价，不增加折扣功能。修复版保持原业务和原必需断言，健康响应检查当前lifecycle.revision。测试名应是稳定标识，不把修订号写入测试名。joint_verifying只运行既有脚本并真实报告，不修改代码、测试或业务目标。失败用integration.report failed，平台只读起草修复方案，管理员批准前不再实施验证。\n${role === "consumer" ? "本项目没有提供方公开contractVersion的值。提交本方plan.submit前须先查本地和共享资料，缺失时使用information.request询证提供方；不能猜测值或要求管理员填。收到答复后复用并把contractVersion及当前revision一起列入就绪契约和实际HTTP联合测试。" : "本方公开协议事实保存在docs/integration-facts.json。"}`);
      if (role === "provider") { await mkdir(join(root,"docs")); await writeFile(join(root,"docs/integration-facts.json"),JSON.stringify({contractVersion})); }
    }
    await exec("git", ["init", "--quiet", root]);
    locals.push({ ...registered, root, role });
  }
  for (const local of locals) {
    await exec("git", ["-C", local.root, "add", "."]);
    await exec("git", ["-C", local.root, "-c", "user.name=Seam Simulation", "-c", "user.email=simulation@seam.test", "commit", "--quiet", "-m", "Initialize isolated acceptance fixture without implementations or tests"]);
  }
  await mkdir(join(runRoot, "mock-state"));
  await startConnectors();
  // Real Connector heartbeats establish online state; the harness never pretends
  // that a worker is connected and never chooses the order of project turns.
  await new Promise((resolve) => setTimeout(resolve, 3000));
  const initial = await Promise.all(locals.map((local) => snapshot(local.root)));
  assert.ok(!contract.includes("discountPercent") && !contract.includes("修订2"), "future business requirements must not be preannounced");
  const created = await api.call("/api/collaborations", {
    title: repairInformation ? "资料获取与审批修复验收" : "合成报价接口联调", objective: repairInformation ? "按双方现有报价协议完成对接，自动查清缺失事实；失败后起草修复方案，经管理员批准后再实施验证。" : revisionOne, projectId: locals[1].project.id, agentId: locals[1].agent.id,
    targetProjectId: locals[0].project.id, targetAgentId: locals[0].agent.id,
  });
  collaborationId = created.id;
  progress("collaboration-created", { collaborationId });
  assert.ok(created.jobs?.length === 2, "the simple create path must automatically join both Agents and start planning");
  const initialDetail = await api.detail(collaborationId);
  assert.equal(initialDetail.participants.filter((item) => item.participant.status === "active").length, 2);
  assert.equal(lifecycle(initialDetail).phase, "planning");
  await api.expect(`/api/collaborations/${collaborationId}/lifecycle`, { action: "approve", revision: 1, documentHash: "0".repeat(64) }, 409);
  await api.expect(`/api/collaborations/${collaborationId}/lifecycle`, { action: "terminate" }, 409);
  await api.expect(`/api/collaborations/${collaborationId}/test-runs`, { participantId: created.participantId }, 409);
  await assertNoUnapprovedWrites(initial);
  checks.push("一次提交目标与两Agent即自动建协作并启动；未形成方案前拒绝提前批准/测试执行");

  const viewerEmail = `simulation-viewer-${suffix}@seam.test`;
  const viewerPassword = "SimulationViewer!2026";
  await api.call("/api/users", { name: "模拟只读用户", email: viewerEmail, password: viewerPassword, role: "viewer" });
  const viewer = new SimulationApi(api.base);
  await viewer.call("/api/auth/login", { email: viewerEmail, password: viewerPassword });
  await viewer.expect(`/api/collaborations/${collaborationId}/lifecycle`, { action: "terminate" }, 403);
  await viewer.expect(`/api/collaborations/${collaborationId}/lifecycle`, { action: "approve", revision: 1, documentHash: "0".repeat(64) }, 403);
  const noSession = new SimulationApi(api.base);
  await noSession.expect(`/api/collaborations/${collaborationId}/lifecycle`, { action: "terminate" }, 401, { token: locals[0].agent.token });
  checks.push("只读用户与Connector Token不能批准或终止协作");

  const revisionCount=repairInformation ? 2 : Number(process.env.SEAM_SIMULATION_REVISIONS ?? 5);
  assert.ok(Number.isInteger(revisionCount) && revisionCount>=2 && revisionCount<=5);
  let baseline=initial, ready;
  if (repairInformation) {
    const first = await runUntilPhase("awaiting_approval"), firstState=lifecycle(first);
    const lookup=firstState.informationRequests.find(row=>row.status==="answered"&&row.responses.some(reply=>reply.mode==="peer"&&reply.status==="found"&&reply.answer.includes(contractVersion)));
    assert.ok(lookup,"the missing fact must come from a persisted peer information response, not the administrator");
    await assertNoUnapprovedWrites(initial);
    await writeFile(join(runRoot,"information-evidence.json"),JSON.stringify({request:lookup,expectedPublicContractVersion:contractVersion},null,2));
    await writeFile(join(runRoot,"revision-1-approved-plan.md"),firstState.document);
    await api.lifecycle(collaborationId,{action:"approve",revision:1,documentHash:firstState.documentHash});
    const verifying=await runUntilPhase("joint_verifying"),oldService=lifecycle(verifying).services.find(row=>row.name==="quote");assert.ok(oldService);
    const implementationBaseline=await Promise.all(locals.map(local=>snapshot(local.root)));
    ready=await runUntilPhase("awaiting_approval");const repair=lifecycle(ready);
    assert.equal(repair.revision,2);assert.equal(repair.repair.sourceRevision,1);assert.equal(repair.approvedHash,null);assert.ok(repair.baseline.report.includes("失败"));
    await assertNoUnapprovedWrites(implementationBaseline);
    await new Promise(resolve=>setTimeout(resolve,2000));await assertNoUnapprovedWrites(implementationBaseline);
    await api.expect(`/api/collaborations/${collaborationId}/lifecycle`,{action:"approve",revision:1,documentHash:firstState.documentHash},409);
    await api.expect(`/api/collaborations/${collaborationId}/test-runs`,{participantId:created.participantId},409);
    const wrongResponse=await fetch(oldService.baseUrl+"/quote",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({sku:"SKU-001",quantity:2})});
    const wrong=await wrongResponse.json();assert.equal(wrong.subtotal,24001,"the failed HTTP implementation remains unchanged before repair approval");
    await writeFile(join(runRoot,"revision-1-report.json"),JSON.stringify({status:"failed",revision:1,documentHash:firstState.documentHash,report:repair.baseline.report,failures:repair.repair.failures,actualFailedHTTPResponse:wrong},null,2));
    await writeFile(join(runRoot,"repair-approval-evidence.json"),JSON.stringify({repair:repair.repair,approvedHashBeforeAdministrator:null,before:implementationBaseline,after:await Promise.all(locals.map(local=>snapshot(local.root))),noRepairWritesBeforeApproval:true},null,2));
    checks.push("本地与共享查找后自动向对端取得公开contractVersion；管理员未填写任何接口资料");
    checks.push("真实HTTP金额故障产生失败证据，平台自动起草修复版；原报告保留、旧批准失效、批准前双方文件保持不变且故障仍存在");
    await approveAndExecute(ready,implementationBaseline);
    const repaired=await api.detail(collaborationId);assert.equal(lifecycle(repaired).repair.sourceRevision,1);
    assert.ok(lifecycle(repaired).integrationReports.every(entry=>entry.checks.every(check=>check.status==="passed")));
    checks.push("管理员确认新修复文档后，两端重新实施并真实验证通过；没有人工追加修复目标或自动批准");
  } else for(let index=0;index<revisionCount;index++){
    if(index>0){
      if(index===3) await restartConsumerWithLostCheckpoint();
      const old=lifecycle(ready);
      await api.lifecycle(collaborationId,{action:"append",requirements:revisions[index]});
      const appended=lifecycle(await api.detail(collaborationId));
      assert.equal(appended.revision,index+1);assert.equal(appended.phase,"planning");
      assert.equal(appended.requirements,revisions[index],"new revision must store its delta, not append all old requirements");
      await api.expect(`/api/collaborations/${collaborationId}/lifecycle`,{action:"approve",revision:old.revision,documentHash:old.documentHash},409);
      await assertNoUnapprovedWrites(baseline);
      checks.push(`修订${index+1}：仅在追加时引入新目标，旧revision/hash不能授权，批准前无写入`);
    }
    ready=await runUntilPhase("awaiting_approval");
    await approveAndExecute(ready,baseline);
    baseline=await Promise.all(locals.map(local=>snapshot(local.root)));
  }
  const beforeTermination = await Promise.all(locals.map((local) => snapshot(local.root)));
  await api.lifecycle(collaborationId, { action: "terminate" });
  const terminated = await api.detail(collaborationId);
  assert.equal(lifecycle(terminated).phase, "terminated");
  assert.ok(!terminated.jobs.some((job) => ["pending", "running"].includes(job.status)));
  await api.expect(`/api/collaborations/${collaborationId}/dispatch`, { autoAdvance: true }, 409);
  await api.expect(`/api/collaborations/${collaborationId}/lifecycle`, { action: "approve", revision: revisionCount, documentHash: lifecycle(ready).documentHash }, 409);
  const oldJob = terminated.jobs.find((job) => job.agentId === locals[0].agent.id && job.status === "completed");
  assert.ok(oldJob);
  await noSession.expect("/api/connectors/complete", {
    agentId: locals[0].agent.id, jobId: oldJob.id, attempts: oldJob.attempts,
    status: "completed", result: { agentTurn: { message: "终止后旧回执不得生效", actions: [] } },
  }, 409, { token: locals[0].agent.token });
  await assertNoUnapprovedWrites(beforeTermination);
  checks.push("管理员终止后无运行任务，禁止继续派发/批准，拒绝旧回执，项目文件保持不变");

  const result = { ok: true, collaborationId, base: api.base, runRoot, checks, revisions: revisionCount, scenario:repairInformation ? "repair-information" : "five-revision", runLabel: `验收-${runRoot.split("-").at(-1)}`,
    concurrency: "two independent continuously polling Connector processes; no provider-first scheduler",
    realAI: "local Codex app-server", virtualPeer: "deterministic provider implemented and tested locally",
    scope: "本地Docker中心及MySQL、两个隔离合成项目、真实HTTP报价接口；不代表实际业务项目联调或生产部署" };
  await writeFile(join(runRoot, "result.json"), JSON.stringify(result, null, 2));
  await writeRunIndex("passed");
  progress("simulation-completed", result);
}

main().catch(async (error) => {
  if (collaborationId) await api.lifecycle(collaborationId, { action: "pause" }).catch(() => {});
  const result = { ok: false, collaborationId, base: api.base, runRoot, checks, error: error instanceof Error ? error.message : String(error) };
  if (runRoot) await writeFile(join(runRoot, "failure.json"), JSON.stringify(result, null, 2)).catch(() => undefined);
  await writeRunIndex("failed").catch(()=>{});
  console.error(JSON.stringify(result, null, 2));
  process.exitCode = 1;
}).finally(async () => {
  for (const { child, local, logs } of workers) {
    try { process.kill(-child.pid, "SIGTERM"); } catch {}
    await writeFile(join(runRoot, `${local.role}-connector.log`), logs.join(""));
  }
  if (runRoot) for (const name of await readdir(join(runRoot, "mock-state")).catch(() => [])) {
    if (!name.endsWith(".json")) continue;
    const service = JSON.parse(await readFile(join(runRoot, "mock-state", name), "utf8"));
    if (service.pid) try { process.kill(service.pid, "SIGTERM"); } catch {}
  }
});
