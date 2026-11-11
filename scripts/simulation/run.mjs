#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { mkdtemp, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { runConnector } from "../../apps/connector/dist/index.js";
import { SimulationApi } from "./http.mjs";
import { agentInstructions, contract, revisionOne, revisionTwo } from "./contract.mjs";
import { publishJointEvidence } from "./publish-joint-evidence.mjs";

const exec = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const api = new SimulationApi();
const checks = [];
let runRoot;
let collaborationId;
let locals = [];
let heartbeatTimer;

function lifecycle(detail) {
  const value = detail.lifecycle ?? detail.collaboration.lifecycle;
  assert.ok(value, "the local service must implement the controlled collaboration lifecycle");
  return value;
}

function progress(event, fields = {}) {
  console.log(JSON.stringify({ event, ...fields }));
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

async function runAgent(local) {
  progress("connector-turn", { role: local.role });
  const original = {
    command: process.env.SEAM_GENERIC_AGENT_COMMAND,
    args: process.env.SEAM_GENERIC_AGENT_ARGS,
    state: process.env.SEAM_APP_SERVER_STATE_DIR,
  };
  try {
    if (local.role === "provider") {
      process.env.SEAM_GENERIC_AGENT_COMMAND = process.execPath;
      process.env.SEAM_GENERIC_AGENT_ARGS = JSON.stringify([join(here, "virtual-agent.mjs")]);
    }
    process.env.SEAM_APP_SERVER_STATE_DIR = join(runRoot, "codex-state");
    await runConnector({
      platformUrl: api.base, agentId: local.agent.id, token: local.agent.token, projectRoot: local.root,
      adapter: local.role === "consumer" ? "codex-app-server" : "generic-cli", codexSandbox: "workspace-write",
      appServerStateDir: join(runRoot, "codex-state"), once: true, pollMs: 100,
    });
  } finally {
    for (const [key, value] of [["SEAM_GENERIC_AGENT_COMMAND", original.command], ["SEAM_GENERIC_AGENT_ARGS", original.args], ["SEAM_APP_SERVER_STATE_DIR", original.state]]) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

async function runUntilPhase(expected, maximum = 18) {
  for (let turn = 0; turn < maximum; turn += 1) {
    const detail = await api.detail(collaborationId);
    const current = lifecycle(detail);
    progress("lifecycle", { revision: current.revision, phase: current.phase, turn });
    if (current.phase === expected) return detail;
    assert.notEqual(current.phase, "terminated", "simulation was terminated before the requested checkpoint");
    assert.ok(["planning", "plan_confirmation", "executing"].includes(current.phase), `unexpected stop before ${expected}: ${current.phase}`);
    const failed = detail.jobs.find((job) => job.status === "failed");
    assert.ok(!failed, `Connector failed: ${failed?.error ?? ""}`);
    const pending = detail.jobs.filter((job) => job.status === "pending");
    assert.ok(!detail.jobs.some((job) => job.status === "running"), "an unexpected competing Connector owns a simulation task");
    assert.ok(pending.length, `the platform did not automatically generate the next ${current.phase} task; the harness will not compensate with a manual dispatch`);
    // Prefer the deterministic provider so Codex can consume its concrete plan.
    const next = pending.find((job) => job.agentId === locals[0].agent.id) ?? pending[0];
    const local = locals.find((item) => item.agent.id === next.agentId);
    assert.ok(local, "task must belong to one of this run's isolated Agents");
    await runAgent(local);
  }
  assert.fail(`did not reach ${expected} within ${maximum} actual Connector turns`);
}

async function jointHttpCheck(revision) {
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
    if (revision >= 2) {
      const discounted = await consumer.getQuote(address, { sku: "SKU-001", quantity: 2, discountPercent: 10 });
      assert.equal(discounted.discount, 2400);
      assert.equal(discounted.total, 21600);
      assert.equal((await consumer.getQuote(address, { sku: "SKU-001", quantity: 2, discountPercent: 100 })).total, 0);
      await assert.rejects(() => consumer.getQuote(address, { sku: "SKU-001", quantity: 1, discountPercent: -1 }));
      const rejectedDiscount = await fetch(`${address}/quote`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sku: "SKU-001", quantity: 1, discountPercent: -1 }) });
      assert.equal(rejectedDiscount.status, 400);
    }
    assert.ok(received >= (revision >= 2 ? 7 : 4), "joint checks must reach the provider through real HTTP");
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
  for (const [role, adapter] of [["provider", "generic-cli"], ["consumer", "codex-app-server"]]) {
    const registered = await api.register(`simulation-${role}-${suffix}`, adapter);
    const root = join(runRoot, role);
    await mkdir(root);
    await writeFile(join(root, "README.md"), `${contract}\n\n本项目职责：${role === "provider" ? "提供方" : "消费方"}。\n`);
    await writeFile(join(root, "AGENTS.md"), agentInstructions);
    await exec("git", ["init", "--quiet", root]);
    locals.push({ ...registered, root, role });
  }
  const sendHeartbeats = () => Promise.all(locals.map((local) => api.call("/api/connectors/heartbeat", {
    agentId: local.agent.id,
    capabilities: {
      adapter: local.role === "consumer" ? "codex-app-server" : "generic-cli",
      executionMode: local.role === "consumer" ? "workspace-write" : "external", testConfigured: false,
    },
  }, { token: local.agent.token })));
  await sendHeartbeats();
  heartbeatTimer = setInterval(() => { void sendHeartbeats().catch((error) => progress("heartbeat-error", { message: error.message })); }, 20_000);
  heartbeatTimer.unref();
  const initial = await Promise.all(locals.map((local) => snapshot(local.root)));
  const created = await api.call("/api/collaborations", {
    objective: revisionOne, projectId: locals[1].project.id, agentId: locals[1].agent.id,
    targetProjectId: locals[0].project.id, targetAgentId: locals[0].agent.id,
  });
  collaborationId = created.id;
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

  const readyOne = await runUntilPhase("awaiting_approval");
  const approvedOne = lifecycle(readyOne);
  await approveAndExecute(readyOne, initial);
  const beforeRevision = await Promise.all(locals.map((local) => snapshot(local.root)));
  await api.lifecycle(collaborationId, { action: "append", requirements: revisionTwo });
  const appended = lifecycle(await api.detail(collaborationId));
  assert.equal(appended.revision, 2);
  assert.equal(appended.phase, "planning");
  await api.expect(`/api/collaborations/${collaborationId}/lifecycle`, { action: "approve", revision: approvedOne.revision, documentHash: approvedOne.documentHash }, 409);
  await assertNoUnapprovedWrites(beforeRevision);
  checks.push("补充目标创建修订2，旧revision/hash不能再次授权执行");
  const readyTwo = await runUntilPhase("awaiting_approval");
  await approveAndExecute(readyTwo, beforeRevision);

  const beforeTermination = await Promise.all(locals.map((local) => snapshot(local.root)));
  await api.lifecycle(collaborationId, { action: "terminate" });
  const terminated = await api.detail(collaborationId);
  assert.equal(lifecycle(terminated).phase, "terminated");
  assert.ok(!terminated.jobs.some((job) => ["pending", "running"].includes(job.status)));
  await api.expect(`/api/collaborations/${collaborationId}/dispatch`, { autoAdvance: true }, 409);
  await api.expect(`/api/collaborations/${collaborationId}/lifecycle`, { action: "approve", revision: 2, documentHash: lifecycle(readyTwo).documentHash }, 409);
  const oldJob = terminated.jobs.find((job) => job.agentId === locals[0].agent.id && job.status === "completed");
  assert.ok(oldJob);
  await noSession.expect("/api/connectors/complete", {
    agentId: locals[0].agent.id, jobId: oldJob.id, attempts: oldJob.attempts,
    status: "completed", result: { agentTurn: { message: "终止后旧回执不得生效", actions: [] } },
  }, 409, { token: locals[0].agent.token });
  await assertNoUnapprovedWrites(beforeTermination);
  checks.push("管理员终止后无运行任务，禁止继续派发/批准，拒绝旧回执，项目文件保持不变");

  const result = { ok: true, collaborationId, base: api.base, runRoot, checks,
    realAI: "local Codex app-server", virtualPeer: "deterministic provider implemented and tested locally",
    scope: "本地Docker中心及MySQL、两个隔离合成项目、真实HTTP报价接口；不代表实际业务项目联调或生产部署" };
  await writeFile(join(runRoot, "result.json"), JSON.stringify(result, null, 2));
  progress("simulation-completed", result);
}

main().catch(async (error) => {
  const result = { ok: false, collaborationId, base: api.base, runRoot, checks, error: error instanceof Error ? error.message : String(error) };
  if (runRoot) await writeFile(join(runRoot, "failure.json"), JSON.stringify(result, null, 2)).catch(() => undefined);
  console.error(JSON.stringify(result, null, 2));
  process.exitCode = 1;
}).finally(() => clearInterval(heartbeatTimer));
