#!/usr/bin/env node
// Public HTTP delivery protocol test. No model or business code is executed.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { SimulationApi } from "./http.mjs";

const api = new SimulationApi();
const output = process.env.SEAM_POLL_RECOVERY_OUTPUT ?? "output/poll-recovery";
const events = [];
const record = (event, data = {}) => { const row = { at: new Date().toISOString(), event, ...data }; events.push(row); console.log(JSON.stringify(row)); };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const tasks = [];
let ok = false;
try {
  await api.loginOwner();
  const suffix = randomUUID().slice(0, 8);
  const peers = [];
  for (const role of ["sender", "receiver"]) {
    const peer = await api.register(`poll-recovery-${role}-${suffix}`, "mock");
    await api.call("/api/connectors/heartbeat", { agentId: peer.agent.id }, { token: peer.agent.token });
    peers.push(peer);
  }
  const peer = peers[1];
  const claim = () => api.call("/api/connectors/poll", { agentId: peer.agent.id, waitMs: 0 }, { token: peer.agent.token });
  const heartbeat = job => api.call("/api/connectors/heartbeat", { agentId: peer.agent.id, activeJob: { id: job.id, attempts: job.attempts } }, { token: peer.agent.token });
  const create = async () => {
    const task = await api.call("/api/collaborations", { title: "轮询断连恢复专项", objective: "显式合成的HTTP领取协议测试，不运行任何模型或业务修改。", projectId: peers[0].project.id, agentId: peers[0].agent.id, targetProjectId: peer.project.id, targetAgentId: peer.agent.id });
    tasks.push(task.id); return task.id;
  };

  // Reproduce the old failure: an idle legacy long poll is disconnected before
  // the next revision/task exists. It must never claim that later task.
  const controller = new AbortController();
  const waiting = fetch(`${api.base}/api/connectors/poll`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${peer.agent.token}` }, body: JSON.stringify({ agentId: peer.agent.id, waitMs: 20_000 }), signal: controller.signal }).then(response => ({ status: response.status }), error => ({ aborted: error.name === "AbortError" }));
  await sleep(750); controller.abort();
  assert.equal((await waiting).aborted, true);
  await sleep(300);
  const firstId = await create();
  await sleep(1200);
  const { job: delivered } = await claim();
  assert.ok(delivered, "disconnected old long poll stole the new task");
  assert.equal(delivered.attempts, 1);
  assert.equal(delivered.collaborationId, firstId);
  assert.ok(Date.parse(delivered.leaseUntil) - Date.now() > 50_000);
  assert.ok(Date.parse(delivered.leaseUntil) - Date.now() <= 60_000);
  const acknowledged = await heartbeat(delivered);
  assert.equal(acknowledged.jobState.cancelRequested, false);
  assert.ok(Date.parse(acknowledged.jobState.leaseUntil) - Date.now() > 19 * 60_000);
  record("abandoned-long-poll-did-not-claim", { collaborationId: firstId, jobId: delivered.id, attempts: delivered.attempts, deliveryLeaseUntil: delivered.leaseUntil, executionLeaseUntil: acknowledged.jobState.leaseUntil });
  await api.lifecycle(firstId, { action: "pause" });

  // A response may be lost even after the server's last disconnect check.
  // Deliberately omit the receive ACK, then observe bounded redelivery.
  const secondId = await create();
  const { job: lost } = await claim(); assert.ok(lost);
  const remaining = Date.parse(lost.leaseUntil) - Date.now();
  assert.ok(remaining > 50_000 && remaining <= 60_000);
  record("delivery-ack-deliberately-omitted", { collaborationId: secondId, jobId: lost.id, attempts: lost.attempts, leaseUntil: lost.leaseUntil, recoveryWaitMs: remaining + 1200 });
  await sleep(remaining + 1200);
  const { job: reclaimed } = await claim();
  assert.equal(reclaimed?.id, lost.id);
  assert.equal(reclaimed.attempts, lost.attempts + 1);
  assert.equal((await heartbeat(lost)).jobState.cancelRequested, true);
  await api.expect("/api/connectors/complete", { agentId: peer.agent.id, jobId: lost.id, attempts: lost.attempts, status: "failed", error: "stale undelivered attempt" }, 409, { token: peer.agent.token });
  const current = await heartbeat(reclaimed);
  assert.equal(current.jobState.cancelRequested, false);
  assert.ok(Date.parse(current.jobState.leaseUntil) - Date.now() > 19 * 60_000);
  record("undelivered-attempt-reclaimed-stale-receipt-rejected", { jobId: reclaimed.id, oldAttempts: lost.attempts, newAttempts: reclaimed.attempts, executionLeaseUntil: current.jobState.leaseUntil });
  ok = true;
} catch (error) {
  record("failed", { error: error.message }); process.exitCode = 1;
} finally {
  for (const id of tasks) await api.lifecycle(id, { action: "pause" }).catch(() => {});
  await mkdir(output, { recursive: true });
  const details = await Promise.all(tasks.map(id => api.detail(id)));
  await writeFile(join(output, "result.json"), JSON.stringify({ ok, scope: "actual local Next.js public HTTP delivery/lease protocol; synthetic participants; no model calls", events, tasks }, null, 2));
  await writeFile(join(output, "details.json"), JSON.stringify(details, null, 2));
}
