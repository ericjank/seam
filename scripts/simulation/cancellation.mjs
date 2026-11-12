#!/usr/bin/env node
// A separate real App Server fault test. Planning receipts are explicit fixtures;
// the approved long command and its interruption run through the real Connector.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runConnector } from "../../apps/connector/dist/index.js";
import { SimulationApi } from "./http.mjs";

const api = new SimulationApi();
const events = [];
const record = (event, fields = {}) => { const value = { at: new Date().toISOString(), event, ...fields }; events.push(value); console.log(JSON.stringify(value)); };
const exists = async (path) => { try { await readFile(path); return true; } catch (error) { if (error.code === "ENOENT") return false; throw error; } };
const waitFor = async (check, timeout) => {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { const result = await check(); if (result) return result; await new Promise(resolve => setTimeout(resolve, 500)); }
  throw new Error("real cancellation checkpoint timed out");
};

const root = await mkdtemp(join(tmpdir(), "seam-real-cancellation-"));
const projectRoot = join(root, "project");
await mkdir(projectRoot);
await writeFile(join(projectRoot, "long-job.mjs"), `import { writeFileSync } from "node:fs";
writeFileSync("started.marker", String(Date.now()));
setTimeout(() => { writeFileSync("finished.marker", String(Date.now())); }, 90000);
`);
await writeFile(join(projectRoot, "README.md"), "# Real cancellation fixture\nRun `node long-job.mjs` exactly once after approval. It creates started.marker immediately, then waits 90 seconds before finished.marker. This duration is intentional: the administrator will pause the task while this command is running. Do not shorten, background, replace or modify this command.\n");
await writeFile(join(projectRoot, "AGENTS.md"), "# Isolated cancellation test\nRead README.md and the approved plan. This is an existing test project, not a business repository. During executing, run `node long-job.mjs` once in the foreground. Do not create other files, change the script, install dependencies, deploy or commit. Wait for its actual result; do not claim success before it exits. If interrupted, do not restart it.\n");

let collaborationId;
let consumerRun;
let connectorError;
try {
  await api.loginOwner();
  const suffix = randomUUID().slice(0, 8);
  const peers = [];
  for (const role of ["controller", "codex"]) {
    const peer = await api.register(`cancellation-${role}-${suffix}`, role === "codex" ? "codex-app-server" : "mock");
    peers.push(peer);
    await api.call("/api/connectors/heartbeat", { agentId: peer.agent.id }, { token: peer.agent.token });
  }
  const created = await api.call("/api/collaborations", {
    objective: "真实停止测试：批准后由Codex前台执行node long-job.mjs，管理员在started.marker出现后暂停，执行端须中断长命令并确认停止。不得缩短90秒等待或自行宣称完成。",
    projectId: peers[0].project.id, agentId: peers[0].agent.id, targetProjectId: peers[1].project.id, targetAgentId: peers[1].agent.id,
  });
  collaborationId = created.id;
  record("fixture-created", { collaborationId, root, scope: "synthetic planning receipts; real native Codex execution and cancellation" });
  const completeFixture = async (peer, action) => {
    const { job } = await api.call("/api/connectors/poll", { agentId: peer.agent.id, waitMs: 0 }, { token: peer.agent.token });
    assert.ok(job);
    await api.call("/api/connectors/complete", { agentId: peer.agent.id, jobId: job.id, attempts: job.attempts, status: "completed", result: { agentTurn: { message: "停止测试的显式合成协商回执，不代表真实模型规划。", kind: "status", actions: [action(job.payload.context)] } } }, { token: peer.agent.token });
  };
  for (const peer of peers) await completeFixture(peer, () => ({ type: "plan.submit", revision: 1, content: "# 暂停测试方案\n" + "这是隔离测试夹具。管理员批准后，仅消费端在前台执行既有node long-job.mjs。程序立即写started.marker并等待90秒；平台暂停后Connector应中断本轮命令，finished.marker不得出现。平台记录停止请求和执行端确认，不能把暂停当作执行通过。" }));
  await completeFixture(peers[0], context => ({ type: "plan.compose", revision: 1, baseDocumentHash: null, contract: {
    scope: "仅验证真实Codex长命令经平台暂停后中断，使用既有long-job.mjs，不修改程序或等待时长。",
    interfaces: [{ id: "cancellation-markers", definition: "node long-job.mjs在前台执行，立即创建started.marker，90秒后才会写finished.marker。管理员看到启动后暂停；中断成功时不应出现finished.marker。" }],
    responsibilities: context.lifecycle.requiredParticipantIds.map((participantId, index) => ({ participantId, changes: index === 0 ? "控制端仅由测试运行器发出管理员暂停，不实施业务改动；协商动作明确为合成测试回执。" : "本机真实Codex读取现有脚本后，严格前台运行node long-job.mjs一次，保持原90秒时长，不修改文件、不后台运行。" })),
    acceptanceCases: context.lifecycle.requiredParticipantIds.map((runnerParticipantId, index) => ({ id: `stop-${index}`, runnerParticipantId, description: "真实停止后的证据核对，暂停不计为实施通过。", command: "node long-job.mjs", expectedResult: "本轮暂停且执行端确认停止，90秒后finished.marker仍不存在。" })),
    risks: "本测试只验证本次独立Node命令和真实Codex中断，不代表所有外部副作用均可撤销。测试停止在暂停状态，不伪造完整实施报告。",
    changeSummary: "首次形成真实暂停验收夹具，协商回执由运行器显式合成，只有实施命令及停止链路使用真实Codex。",
    impactedParticipantIds: context.lifecycle.requiredParticipantIds, retainedDecisions: [],
  } }));
  for (const peer of peers) await completeFixture(peer, context => ({ type: "plan.confirm", revision: 1, documentHash: context.lifecycle.documentHash }));
  const ready = await api.detail(collaborationId);
  assert.equal(ready.lifecycle.phase, "awaiting_approval");
  await api.lifecycle(collaborationId, { action: "approve", revision: 1, documentHash: ready.lifecycle.documentHash });
  consumerRun = runConnector({ platformUrl: api.base, agentId: peers[1].agent.id, token: peers[1].agent.token, projectRoot,
    adapter: "codex-app-server", codexSandbox: "workspace-write", codexNetworkAccess: false,
    appServerStateDir: join(root, "codex-state"), stateDir: join(root, "receipts"), workspaceLockDir: join(root, "locks"), once: true, pollMs: 100,
  }).catch(error => { connectorError = error; });
  const startedAt = await waitFor(async () => await exists(join(projectRoot, "started.marker")) && Number(await readFile(join(projectRoot, "started.marker"), "utf8")), 240000);
  record("real-command-started", { startedAt });
  await api.lifecycle(collaborationId, { action: "pause" });
  record("administrator-paused");
  const stopped = await waitFor(async () => {
    const detail = await api.detail(collaborationId);
    const job = detail.jobs.find(value => value.agentId === peers[1].agent.id && value.kind === "collaboration.turn" && value.status === "cancelled" && value.cancellationAckAt);
    return job && { detail, job };
  }, 90000);
  record("connector-stop-confirmed", { jobId: stopped.job.id, cancellationAckAt: stopped.job.cancellationAckAt, attempts: stopped.job.attempts });
  await consumerRun;
  if (connectorError) throw connectorError;
  // Wait beyond the original deadline to detect a command orphan continuing
  // after the Connector has acknowledged cancellation.
  await waitFor(async () => Date.now() >= startedAt + 95000, 100000);
  assert.equal(await exists(join(projectRoot, "finished.marker")), false, "the cancelled native command continued after stop acknowledgement");
  const detail = await api.detail(collaborationId);
  assert.equal(detail.lifecycle.paused, true);
  assert.equal(detail.jobs.some(job => ["pending", "running"].includes(job.status)), false);
  assert.equal(detail.lifecycle.reports.length, 0);
  await writeFile(join(root, "detail.json"), JSON.stringify(detail, null, 2));
  const result = { ok: true, root, projectRoot, collaborationId, events, finishedMarkerExists: false, waitedBeyondOriginalDeadline: true, scope: "real local Codex App Server cancellation; planning receipts were synthetic; task intentionally left paused" };
  await writeFile(join(root, "result.json"), JSON.stringify(result, null, 2));
  record("real-cancellation-passed", { root, collaborationId, finishedMarkerExists: false, waitedBeyondOriginalDeadline: true });
} catch (error) {
  if (collaborationId) await api.lifecycle(collaborationId, { action: "pause" }).catch(() => {});
  const result = { ok: false, root, collaborationId, events, error: error.message };
  await writeFile(join(root, "failure.json"), JSON.stringify(result, null, 2));
  console.error(JSON.stringify(result));
  process.exitCode = 1;
}
