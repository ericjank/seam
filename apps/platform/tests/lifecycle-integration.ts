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
async function complete(local: Local, job: Claimed, action: Record<string, unknown>, status = 200) {
  const body = { agentId: local.agentId, jobId: job.id, attempts: job.attempts, status: "completed", result: { agentTurn: {
    message: "确定性 HTTP 负例测试回执；本回执不代表真实业务实施", kind: "status", actions: [action], notifyParticipantIds: [], needsHumanInput: false,
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
  const create = { title: `lifecycle-negative-${suffix}`, objective: "仅验证生命周期权限、回滚和旧版本隔离，不调用模型或业务服务", projectId: first.projectId, targetProjectId: second.projectId };
  await expected("/api/collaborations", create, 409);
  const listed = await api("/api/collaborations", undefined, { method: "GET" });
  assert.ok(!listed.collaborations.some((row: any) => row.collaboration.title === create.title), "failed offline creation must roll back its collaboration and participants");
  for (const local of [first, second]) await api("/api/connectors/heartbeat", { agentId: local.agentId }, { token: local.token });
  const created = await api("/api/collaborations", create);
  const path = `/api/collaborations/${created.id}`;
  const detail = () => api(path, undefined, { method: "GET" });
  const lifecycle = (body: unknown) => api(`${path}/lifecycle`, body);
  const duplicate = await api(`${path}/dispatch`, { autoAdvance: true });
  assert.deepEqual([...duplicate.jobs].sort(), [...created.jobs].sort());
  await expected(`${path}/messages`, { body: "跳过文档批准，立即实施另一个目标", dispatch: true }, 409);
  checks.push("离线创建完整回滚；双方在线一次创建；重复派发合并已有批次");

  const a1 = await claim(first), b1 = await claim(second);
  await complete(first, a1, { type: "execution.report", revision: 1, status: "passed", summary: "尝试绕过人工批准", evidence: {} }, 409);
  await submit(second, b1); await submit(first);
  const beforeEdit = (await detail()).lifecycle;
  const aConfirm = await claim(first), bConfirm = await claim(second);
  await confirm(first, aConfirm);
  await submit(second, bConfirm, "根据对端评审修订接口错误约定与测试边界");
  const afterEdit = (await detail()).lifecycle;
  assert.notEqual(afterEdit.documentHash, beforeEdit.documentHash);
  assert.deepEqual(afterEdit.confirmations, []);
  const staleHash = await claim(first);
  await complete(first, staleHash, { type: "plan.confirm", revision: 1, documentHash: beforeEdit.documentHash }, 409);
  await confirm(second); await confirm(first);
  const ready = (await detail()).lifecycle;
  assert.equal(ready.phase, "awaiting_approval");
  assert.equal(ready.confirmations.length, 2);
  await expected(`${path}/lifecycle`, { action: "approve", revision: 1, documentHash: "0".repeat(64) }, 409);
  await expected(`${path}/lifecycle`, { action: "terminate", revision: 1 }, 409);
  checks.push("审批前实施回执拒绝；确认期间可修订；双方重新确认新hash；旧hash与提前终止被拒绝");

  const memberEmail = `lifecycle-negative-${suffix}@seam.test`, memberPassword = `Fixture-${suffix}`;
  await api("/api/users", { name: "生命周期负例普通成员", email: memberEmail, password: memberPassword, role: "member" });
  memberCookie = await login(memberEmail, memberPassword);
  await expected(`${path}/lifecycle`, { action: "approve", revision: 1, documentHash: ready.documentHash }, 403, { session: memberCookie });
  await expected(`${path}/lifecycle`, { action: "append", requirements: "普通成员试图改要求" }, 403, { session: memberCookie });
  const next = await lifecycle({ action: "append", requirements: "第二版增加幂等校验，旧版批准不可复用" });
  assert.equal(next.lifecycle.revision, 2);
  await expected(`${path}/lifecycle`, { action: "approve", revision: 1, documentHash: ready.documentHash }, 409);
  await submit(first); await submit(second); await confirm(first); await confirm(second);
  const ready2 = (await detail()).lifecycle;
  assert.equal(ready2.phase, "awaiting_approval");
  await lifecycle({ action: "approve", revision: 2, documentHash: ready2.documentHash });
  await expected(`${path}/lifecycle`, { action: "append", requirements: "执行中不能换版" }, 409);
  await expected(`${path}/lifecycle`, { action: "terminate", revision: 2 }, 409);
  const executing = await detail();
  assert.equal(executing.jobs.filter((job: any) => ["pending", "running"].includes(job.status)).length, 2);
  checks.push("普通成员不能批准/改要求；新版拒绝旧版批准；实施期间不能追加或终止");

  for (const [local, status] of [[first, "failed"], [second, "passed"]] as const) {
    const job = await claim(local);
    await complete(local, job, { type: "execution.report", revision: 2, status, summary: `负例合成回执：${status}；未调用真实模型、未实施业务代码`, evidence: { synthetic: true } });
  }
  const reviewed = await detail();
  assert.equal(reviewed.lifecycle.phase, "awaiting_review");
  assert.equal(reviewed.collaboration.status, "validating");
  assert.ok(reviewed.lifecycle.reports.some((report: any) => report.status === "failed"));
  assert.equal(reviewed.jobs.filter((job: any) => ["pending", "running"].includes(job.status)).length, 0);
  await expected(`${path}/lifecycle`, { action: "terminate", revision: 2 }, 403, { session: memberCookie });
  await expected(`${path}/lifecycle`, { action: "terminate", revision: 1 }, 409);
  await lifecycle({ action: "terminate", revision: 2 });
  await expected(`${path}/dispatch`, { autoAdvance: true }, 409);
  assert.equal((await detail()).collaboration.status, "completed");
  checks.push("失败报告保持failed；报告收齐仍待人工；仅管理员可按当前版本终止；终止后禁止再派发");
  console.log(JSON.stringify({ status: "passed", collaborationId: created.id, checks }, null, 2));
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
