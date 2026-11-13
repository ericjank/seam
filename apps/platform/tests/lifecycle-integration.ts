import { fixtureContract, fixtureRuns } from "./fixtures/shared-contract";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

// HTTP-only negative coverage against the separate local simulation service.
// No Codex invocation, no direct SQL, and no changes to existing collaborations.
const base = process.env.SEAM_LIFECYCLE_TEST_URL ?? "http://127.0.0.1:13079";
const url = new URL(base);
assert.ok(["127.0.0.1", "localhost", "[::1]"].includes(url.hostname), "only local test services are allowed");
assert.notEqual(url.port || "80", "3000", "use the isolated simulation service, never the normal installation on port 3000");
const suffix = randomUUID();
let cookie = "";
let memberCookie = "";
const checks: string[] = [];
type Local = { projectId: string; agentId: string; token: string };
type Claimed = { id: string; attempts: number; payload: { context: { participant: { id: string }; lifecycle: { revision: number; documentHash: string } } } };

async function raw(path: string, body?: unknown, options: { token?: string; session?: string; method?: string } = {}) {
  const response = await fetch(`${base}${path}`, {
    method: options.method ?? "POST",
    headers: {
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...(options.token ? { authorization: `Bearer ${options.token}` } : { cookie: options.session ?? cookie }),
    },
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(30_000),
  });
  return { response, data: await response.json() as Record<string, any> };
}
async function api(path: string, body?: unknown, options: { token?: string; session?: string; method?: string } = {}) {
  const result = await raw(path, body, options);
  assert.ok(result.response.ok, `${path}: ${result.response.status} ${JSON.stringify(result.data)}`);
  return result.data;
}
async function expected(path: string, body: unknown, status: number, options: { token?: string; session?: string } = {}) {
  const result = await raw(path, body, options);
  assert.equal(result.response.status, status, `${path}: ${JSON.stringify(result.data)}`);
}
async function login(email: string, password: string) {
  const result = await raw("/api/auth/login", { email, password });
  assert.ok(result.response.ok, JSON.stringify(result.data));
  const session = result.response.headers.get("set-cookie");
  assert.ok(session);
  assert.ok(session.startsWith("seam_session="));
  return session.split(";")[0]!;
}
async function register(label: string): Promise<Local> {
  const { project } = await api("/api/projects", { name: `lifecycle-negative-${label}-${suffix}`, description: "确定性生命周期负例测试" });
  const { agent } = await api("/api/agents", { projectId: project.id, name: `fixture-${label}`, adapter: "generic-cli" });
  return { projectId: project.id, agentId: agent.id, token: agent.token };
}
async function claim(local: Local): Promise<Claimed> {
  const result = await api("/api/connectors/poll", { agentId: local.agentId, waitMs: 0 }, { token: local.token });
  assert.ok(result.job, "the platform must automatically enqueue the expected turn");
  return result.job;
}
function content(local: Local, extra = "") {
  return `# ${local.agentId} 的完整开发贡献\n\n${"读取合成项目，明确接口边界与实施步骤，审批前只读，审批后实际执行并提交测试证据。".repeat(4)}\n\n${extra}`;
}
async function complete(local: Local, job: Claimed, action: Record<string, unknown> | Record<string, unknown>[], status = 200) {
  const body = { agentId: local.agentId, jobId: job.id, attempts: job.attempts, status: "completed", result: { agentTurn: {
    message: "确定性 HTTP 负例测试回执；本回执不代表真实业务实施", kind: "status", actions: Array.isArray(action) ? action : [action], notifyParticipantIds: [], needsHumanInput: false,
  } } };
  if (status === 200) return api("/api/connectors/complete", body, { token: local.token });
  await expected("/api/connectors/complete", body, status, { token: local.token });
}
async function submit(local: Local, job?: Claimed, extra = "") {
  const claimed = job ?? await claim(local);
  return complete(local, claimed, { type: "plan.submit", revision: claimed.payload.context.lifecycle.revision, content: content(local, extra) });
}
async function confirm(local: Local, job?: Claimed) {
  const claimed = job ?? await claim(local);
  return complete(local, claimed, { type: "plan.confirm", revision: claimed.payload.context.lifecycle.revision, documentHash: claimed.payload.context.lifecycle.documentHash });
}
async function main() {
  await api("/api/health", undefined, { method: "GET" });
  cookie = await login(process.env.SEAM_SIMULATION_EMAIL ?? "simulation-owner@seam.test", process.env.SEAM_SIMULATION_PASSWORD ?? "LocalSimulation!2026");
  const first = await register("a"), second = await register("b");
  const create = { title: `lifecycle-upgrade-${suffix}`, objective: "仅验证隔离模拟服务的统一契约、可靠回执、暂停及联合验收，不冒充真实模型实施", projectId: first.projectId, targetProjectId: second.projectId };
  await expected("/api/collaborations", create, 409);
  const listed = await api("/api/collaborations", undefined, { method: "GET" });
  assert.ok(!listed.collaborations.some((row: any) => row.collaboration.title === create.title));
  for (const local of [first, second]) await api("/api/connectors/heartbeat", { agentId: local.agentId }, { token: local.token });
  const created = await api("/api/collaborations", create);
  const path = `/api/collaborations/${created.id}`;
  const detail = () => api(path, undefined, { method: "GET" });
  const lifecycle = (body: unknown) => api(`${path}/lifecycle`, body);
  let strictContractChecked = false;
  const compose = async (extra = "") => {
    const current = await detail();
    assert.equal(current.lifecycle.phase, "plan_synthesis");
    assert.equal(current.jobs.filter((j: any) => ["pending", "running"].includes(j.status)).length, 1);
    const participant = current.participants.find((row: any) => row.participant.id === current.lifecycle.coordinatorParticipantId).participant;
    const coordinator = [first, second].find((local) => local.agentId === participant.agentId)!;
    let job = await claim(coordinator);
    if (!strictContractChecked) {
      const contract = fixtureContract(current.lifecycle.requiredParticipantIds, current.lifecycle.revision, extra);
      const missingService = { ...contract }; delete missingService.serviceExpectations;
      await complete(coordinator, job, { type: "plan.compose", revision: current.lifecycle.revision, baseDocumentHash: current.lifecycle.documentHash, contract: missingService }, 422);
      await api(`${path}/dispatch`, { autoAdvance: true });
      job = await claim(coordinator);
      await complete(coordinator, job, { type: "plan.compose", revision: current.lifecycle.revision, baseDocumentHash: current.lifecycle.documentHash, contract: { ...contract, acceptanceCases: contract.acceptanceCases.map(item => ({ ...item, requiredAssertions: [] })) } }, 422);
      await api(`${path}/dispatch`, { autoAdvance: true });
      job = await claim(coordinator); strictContractChecked = true;
      checks.push("新契约不得省略就绪声明或必需断言；拒绝后显式重试同阶段，错误内容不生效");
    }
    await complete(coordinator, job, { type: "plan.compose", revision: current.lifecycle.revision, baseDocumentHash: current.lifecycle.documentHash, contract: fixtureContract(current.lifecycle.requiredParticipantIds, current.lifecycle.revision, extra) });
  };
  const duplicate = await api(`${path}/dispatch`, { autoAdvance: true });
  assert.deepEqual([...duplicate.jobs].sort(), [...created.jobs].sort());
  await expected(`${path}/messages`, { body: "跳过审批实施", dispatch: true }, 409);
  checks.push("离线创建完整回滚；双方在线一次创建；重复派发合并；拒绝聊天旁路");

  const a1 = await claim(first), b1 = await claim(second);
  await complete(first, a1, { type: "execution.report", revision: 1, status: "passed", summary: "试图绕过批准", evidence: {} }, 409);
  await submit(second, b1); await submit(first);
  await compose();
  const beforeEdit = (await detail()).lifecycle;
  const aConfirm = await claim(first), bConfirm = await claim(second);
  await confirm(first, aConfirm);
  await complete(second, bConfirm, { type: "plan.reject", revision: 1, documentHash: beforeEdit.documentHash, reason: "请在共同范围中明确本轮错误边界与测试责任" });
  const rejected = (await detail()).lifecycle;
  assert.deepEqual(rejected.confirmations, []); assert.equal(rejected.objections.length, 1);
  await compose("本次明确错误边界及双方测试责任。");
  const afterEdit = (await detail()).lifecycle;
  assert.notEqual(afterEdit.documentHash, beforeEdit.documentHash);
  const staleHash = await claim(first);
  await complete(first, staleHash, { type: "plan.confirm", revision: 1, documentHash: beforeEdit.documentHash }, 409);
  await confirm(second); await confirm(first);
  const ready = (await detail()).lifecycle;
  assert.equal(ready.phase, "awaiting_approval");
  assert.ok(ready.document.includes("唯一接口契约")); assert.ok(ready.document.includes("联合验收"));
  await expected(`${path}/lifecycle`, { action: "approve", revision: 1, documentHash: "0".repeat(64) }, 409);
  await expected(`${path}/lifecycle`, { action: "terminate", revision: 1 }, 409);
  checks.push("统一契约仅协调方汇总；异议作废双方确认；修订后拒绝旧hash；管理员批准前禁止实施");

  const memberEmail = `lifecycle-negative-${suffix}@seam.test`, memberPassword = `Fixture-${suffix}`;
  await api("/api/users", { name: "生命周期普通成员", email: memberEmail, password: memberPassword, role: "member" });
  memberCookie = await login(memberEmail, memberPassword);
  for (const body of [{ action: "approve", revision: 1, documentHash: ready.documentHash }, { action: "append", requirements: "越权改要求" }, { action: "pause" }]) await expected(`${path}/lifecycle`, body, 403, { session: memberCookie });
  const next = await lifecycle({ action: "append", requirements: "第二版增量增加折扣，复用已有路径和金额约定" });
  assert.equal(next.lifecycle.revision, 2); assert.equal(next.lifecycle.baseline.documentHash, ready.documentHash);
  assert.ok(next.lifecycle.baseline.contract); assert.ok(next.lifecycle.changeRequest.includes("增量")); assert.equal(next.lifecycle.approvedHash, null);
  await expected(`${path}/lifecycle`, { action: "approve", revision: 1, documentHash: ready.documentHash }, 409);
  await submit(first); await submit(second); await compose(); await confirm(first); await confirm(second);
  const ready2 = (await detail()).lifecycle;
  assert.ok(ready2.document.includes("复用的既有决定")); assert.ok(ready2.document.includes("保留 POST /quote"));
  await lifecycle({ action: "approve", revision: 2, documentHash: ready2.documentHash });
  checks.push("普通成员不得批准/改要求/暂停；追加要求保留上版契约，展示增量且不继承旧批准");

  const interrupted = await claim(first);
  const heartbeat = await api("/api/connectors/heartbeat", { agentId: first.agentId, activeJob: { id: interrupted.id, attempts: interrupted.attempts } }, { token: first.token });
  assert.equal(heartbeat.jobState.cancelRequested, false); assert.ok(heartbeat.jobState.leaseUntil);
  await lifecycle({ action: "pause" });
  const stopped = await api("/api/connectors/heartbeat", { agentId: first.agentId, activeJob: { id: interrupted.id, attempts: interrupted.attempts, cancelled: true } }, { token: first.token });
  assert.equal(stopped.jobState.cancelRequested, true);
  assert.ok((await detail()).jobs.find((job: any) => job.id === interrupted.id).cancellationAckAt);
  await complete(first, interrupted, { type: "execution.report", revision: 2, status: "passed", summary: "旧暂停任务不能提交", evidence: {} }, 409);
  await expected(`${path}/dispatch`, { autoAdvance: true }, 409);
  await lifecycle({ action: "resume" });
  assert.equal((await detail()).lifecycle.paused, false);
  await expected(`${path}/lifecycle`, { action: "append", requirements: "执行中换版" }, 409);
  checks.push("长任务租约续期；暂停传达取消并保存停止确认；旧任务被拒绝；恢复自动补派发");

  const firstExecution = await claim(first);
  const report = { type: "execution.report", revision: 2, status: "passed", summary: "合成协议实施回执，不代表真实业务完成", evidence: { synthetic: true } };
  await complete(first, firstExecution, report); await complete(first, firstExecution, report);
  assert.equal((await detail()).lifecycle.reports.length, 1);
  const secondExecution = await claim(second); await complete(second, secondExecution, report);
  const verifying = (await detail()).lifecycle;
  assert.equal(verifying.phase, "joint_verifying"); assert.equal(verifying.report, null);
  await expected(`${path}/lifecycle`, { action: "terminate", revision: 2 }, 409);
  checks.push("完成回执重复提交幂等，动作只应用一次；双方实施收齐后必须进入独立联合验收");

  const jointAction = (job: Claimed, status: string) => ({ type: "integration.report", revision: 2, documentHash: verifying.documentHash, runs: status === "passed" ? fixtureRuns(job.id) : [],
    checks: verifying.contract.acceptanceCases.filter((item: any) => item.runnerParticipantId === job.payload.context.participant.id).map((item: any) => ({ caseId: item.id, status, command: item.command, summary: "合成协议用例，明确记录未执行状态", evidence: { synthetic: true }, assertionNames: status === "passed" ? ["fixture HTTP contract"] : [], runIds: status === "passed" ? [`fixture-${job.id}`] : [] })),
  });
  const waitingJob = await claim(first);
  await complete(first, waitingJob, [jointAction(waitingJob, "not_run"), { type: "workflow.blocked", revision: 2, kind: "waiting_peer", reason: "合成故障复现：当前服务不可达，未执行并等待对端恢复。", dependencyParticipantIds: [verifying.requiredParticipantIds.find((id: string) => id !== waitingJob.payload.context.participant.id)], retryAfterSeconds: 5 }]);
  const waiting = await detail();
  assert.equal(waiting.lifecycle.phase, "joint_verifying"); assert.equal(waiting.lifecycle.report, null);
  assert.equal(waiting.lifecycle.integrationReports.length, 0); assert.equal(waiting.lifecycle.blocks[0].kind, "waiting_peer");
  const storedWait = waiting.jobs.find((job: any) => job.id === waitingJob.id);
  assert.equal(storedWait.status, "completed"); // Public job summaries intentionally omit the original result body.
  await lifecycle({ action: "resume", resolution: "合成协议测试补充服务恢复事实，仅验证阻塞续接，不代表真实HTTP就绪。" });
  checks.push("未执行说明与等待并存时保留原始回执，只应用阻塞不提前出报告，补充事实后续接同一修订");
  for (const [local, status] of [[second, "passed"], [first, "not_run"]] as const) {
    const job = await claim(local);
    await complete(local, job, jointAction(job, status));
  }
  const reviewed = await detail();
  assert.equal(reviewed.lifecycle.phase, "planning"); assert.equal(reviewed.lifecycle.revision, 3);
  assert.ok(reviewed.lifecycle.baseline.report.includes("未执行用例"));assert.equal(reviewed.lifecycle.repair.sourceRevision,2);assert.equal(reviewed.lifecycle.approvedHash,null);
  assert.equal(reviewed.collaboration.status, "negotiating");
  await expected(`${path}/lifecycle`, { action: "terminate", revision: 3 }, 403, { session: memberCookie });
  await lifecycle({ action: "terminate", revision: 3 });
  await expected(`${path}/dispatch`, { autoAdvance: true }, 409);
  assert.equal((await detail()).collaboration.status, "completed");
  checks.push("联测未执行保留原失败报告并自动起草修复版；不继承批准；管理员可终止未执行修复草案，终止后不再派发");
  console.log(JSON.stringify({ status: "passed", collaborationId: created.id, scope: "真实HTTP协议与权限验证，Agent结果为明确标注的合成回执", checks }, null, 2));
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
