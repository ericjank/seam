import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { and, asc, eq } from "drizzle-orm";
import { runConnector } from "@seam/connector";
import { db, pool } from "../src/db";
import { connectorJobs } from "../src/db/schema";
import { newId } from "../src/lib/ids";

// This suite deliberately uses a real local HTTP service and Connector, but a
// deterministic CLI fixture instead of a paid AI or either business project.
const base = process.env.SEAM_APP_URL ?? "http://127.0.0.1:3000";
const checks: string[] = [];
const runId = newId();
let cookie = "";
let temporaryRoot: string | undefined;
type Agent = { id: string; token: string };
type LocalAgent = { agent: Agent; root: string; projectId: string };

async function raw(path: string, body?: unknown, token?: string, method = "POST") {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: {
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...(token ? { authorization: `Bearer ${token}` } : cookie ? { cookie } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  const session = response.headers.get("set-cookie");
  if (session?.startsWith("seam_session=")) cookie = session.split(";")[0]!;
  const data = await response.json() as Record<string, any>;
  return { response, data };
}

async function api(path: string, body?: unknown, token?: string, method = "POST") {
  const { response, data } = await raw(path, body, token, method);
  assert.ok(response.ok, `${method} ${path}: HTTP ${response.status} ${JSON.stringify(data)}`);
  return data;
}

async function detail(id: string) {
  return api(`/api/collaborations/${id}`, undefined, undefined, "GET");
}

async function jobs(id: string) {
  return db.select().from(connectorJobs).where(eq(connectorJobs.collaborationId, id)).orderBy(asc(connectorJobs.sequence));
}

async function createCollaboration(local: LocalAgent, label: string) {
  return api("/api/collaborations", {
    title: `${label} ${runId}`, objective: "仅用合成数据验证 Seam 自动协作，不调用真实业务服务",
    projectId: local.projectId,
    // Intentionally omit agentId: a project with one Agent must bind it itself.
  });
}

async function fixture(local: LocalAgent, value: Record<string, unknown>) {
  await rm(join(local.root, "started.json"), { force: true });
  await rm(join(local.root, "release.json"), { force: true });
  await writeFile(join(local.root, "fixture.json"), JSON.stringify(value));
}

async function execute(local: LocalAgent) {
  await runConnector({
    platformUrl: base, agentId: local.agent.id, token: local.agent.token,
    projectRoot: local.root, adapter: "generic-cli", once: true, pollMs: 100,
  });
}

async function drain(id: string, locals: LocalAgent[], maximum = 12) {
  for (let count = 0; count < maximum; count += 1) {
    const rows = await jobs(id);
    const next = rows.find((job) => job.status === "pending");
    if (!next) {
      assert.ok(!rows.some((job) => job.status === "running"), "fixture driver must not leave running jobs");
      return rows;
    }
    const local = locals.find((candidate) => candidate.agent.id === next.agentId);
    assert.ok(local, "all pending jobs must belong to this suite's local fixtures");
    await execute(local);
  }
  assert.fail(`workflow did not become idle within ${maximum} fixture executions`);
}

async function waitUntilStarted(local: LocalAgent) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const value = await readFile(join(local.root, "started.json"), "utf8").catch(() => undefined);
    if (value) return JSON.parse(value) as { jobId: string };
    await delay(25);
  }
  assert.fail("fixture CLI did not report that it had received the task context");
}

async function expectStatus(path: string, body: unknown, expected: number) {
  const result = await raw(path, body);
  assert.equal(result.response.status, expected, `${path}: ${JSON.stringify(result.data)}`);
  return result.data;
}

const fakeCliSource = String.raw`
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { setTimeout } from "node:timers/promises";
const prompt = process.argv.at(-1);
const marker = "协作上下文：";
assert.ok(prompt.includes(marker), "structured collaboration context must reach the actual child process");
const context = JSON.parse(prompt.slice(prompt.lastIndexOf(marker) + marker.length));
assert.ok(context.jobId, "the actual platform job id must be supplied");
const fixture = JSON.parse(await readFile("fixture.json", "utf8"));
await writeFile("observed.json", JSON.stringify(context));
await writeFile("started.json", JSON.stringify({jobId: context.jobId}));
if (fixture.waitForRelease) {
  const deadline = Date.now() + 20000;
  let released = false;
  while (Date.now() < deadline) {
    released = await readFile("release.json").then(() => true, () => false);
    if (released) break;
    await setTimeout(25);
  }
  assert.ok(released, "the test driver must release the in-flight fixture after sending its instruction");
}
if (fixture.delayMs) await setTimeout(fixture.delayMs);
let actions = fixture.actions ?? [];
if (fixture.mode === "publish" && !context.artifacts.some(a => a.title === "合成接口契约")) {
  await writeFile("implementation.txt", "synthetic provider implementation executed locally");
  actions = [{type:"artifact.upsert", title:"合成接口契约", artifactType:"markdown", content:"合成接口：POST /fixture；只供本地验证"}];
}
if (fixture.mode === "acknowledge" && context.artifacts.some(a => a.title === "合成接口契约") && !context.artifacts.some(a => a.title === "合成消费方回执")) {
  await writeFile("implementation.txt", "synthetic consumer implementation executed locally");
  actions = [{type:"artifact.upsert", title:"合成消费方回执", artifactType:"test-report", content:"已通过真实 Connector 收到合成接口契约；不代表业务验收"}];
}
console.log(JSON.stringify({message:fixture.message ?? "合成 CLI 执行回执", kind:"status", actions, notifyParticipantIds:[], needsHumanInput:fixture.needsHumanInput ?? false}));
`;

async function main() {
  const target = new URL(base);
  assert.ok(["127.0.0.1", "localhost", "[::1]"].includes(target.hostname), "test:workflow may only address a local service");
  assert.ok(["127.0.0.1", "localhost", "::1"].includes(process.env.DB_HOST ?? "127.0.0.1"), "test database must be local");
  assert.match(process.env.DB_DATABASE ?? "", /^seam_[a-z0-9_]*test$/, "set an explicit, isolated seam_*test database");
  temporaryRoot = await mkdtemp(join(tmpdir(), "seam-workflow-"));
  const fakeCli = join(temporaryRoot, "fake-agent.mjs");
  await writeFile(fakeCli, fakeCliSource);
  process.env.SEAM_GENERIC_AGENT_COMMAND = process.execPath;
  process.env.SEAM_GENERIC_AGENT_ARGS = JSON.stringify([fakeCli]);

  const email = process.env.SEAM_TEST_OWNER_EMAIL ?? "owner@seam.test";
  const password = process.env.SEAM_TEST_OWNER_PASSWORD ?? "SeamTest!12345";
  const setup = await raw("/api/setup", { name: "Seam 测试所有者", email, password, organizationName: "Seam 测试组织" });
  if (setup.response.status === 409) await api("/api/auth/login", { email, password });
  else assert.ok(setup.response.ok, JSON.stringify(setup.data));
  // Setup does not necessarily establish a session.
  await api("/api/projects", undefined, undefined, "GET").catch(() => api("/api/auth/login", { email, password }));

  const locals: LocalAgent[] = [];
  for (const name of ["provider", "consumer"]) {
    const { project } = await api("/api/projects", { name: `workflow-${name}-${runId}`, description: "合成测试项目" });
    const { agent } = await api("/api/agents", { projectId: project.id, name: `fixture-${name}`, adapter: "generic-cli" });
    const root = await mkdtemp(join(temporaryRoot, `${name}-`));
    locals.push({ projectId: project.id, agent, root });
  }
  const provider = locals[0]!;
  const consumer = locals[1]!;

  const collaboration = await createCollaboration(provider, "双端自动交接");
  const { participant } = await api(`/api/collaborations/${collaboration.id}/participants`, { projectId: consumer.projectId, role: "consumer" });
  await api(`/api/participants/${participant.id}/accept`, {});
  await api(`/api/collaborations/${collaboration.id}/messages`, { body: "这只是保存的留言", dispatch: false });
  assert.equal((await jobs(collaboration.id)).length, 0, "a passive comment must not dispatch a task");
  const dispatched = await api(`/api/collaborations/${collaboration.id}/messages`, { body: "请双方读取本地项目，发布合成契约并回传消费证据" });
  assert.equal(dispatched.jobs.length, 2, "sending a goal must dispatch both bound Agents by default");
  const duplicate = await api(`/api/collaborations/${collaboration.id}/dispatch`, { autoAdvance: true });
  assert.deepEqual([...duplicate.jobs].sort(), [...dispatched.jobs].sort(), "repeat dispatch must join the existing batch");
  await fixture(provider, { mode: "publish" });
  await fixture(consumer, { mode: "acknowledge" });
  const handoffJobs = await drain(collaboration.id, locals);
  const handoff = await detail(collaboration.id);
  assert.equal(handoff.artifacts.length, 2, "both local CLI fixtures must publish through the Connector");
  assert.ok(handoffJobs.length >= 4, "changed output must automatically schedule the receiving Agents");
  assert.ok(handoffJobs.every((job) => job.status === "completed"));
  assert.match(await readFile(join(provider.root, "implementation.txt"), "utf8"), /provider/);
  assert.match(await readFile(join(consumer.root, "implementation.txt"), "utf8"), /consumer/);
  assert.ok(handoff.messages.some((message: any) => message.body.includes("没有新的交接")), "unchanged fixture turns must stop the workflow");
  checks.push("发送默认派发、仅留言、唯一Agent自动绑定、重复派发合流、真实双端Connector自动交接与停止");

  const contextual = await createCollaboration(provider, "领取时上下文刷新");
  const originalInstruction = `早期用户约束-${runId}`;
  await api(`/api/collaborations/${contextual.id}/messages`, { body: originalInstruction, dispatch: false });
  for (let index = 0; index < 31; index += 1) {
    await api(`/api/collaborations/${contextual.id}/messages`, { body: `背景留言 ${index}`, dispatch: false });
  }
  const queued = await api(`/api/collaborations/${contextual.id}/messages`, { body: "读取最新已有资料，不要求用户重新填写" });
  const artifact = await api(`/api/collaborations/${contextual.id}/artifacts`, { title: "排队后新增资料", type: "markdown", content: "领取任务时应可见的共享资料" });
  const proposal = await api(`/api/collaborations/${contextual.id}/proposals`, { operation: "create", title: "排队后新增提案", body: "合成提案", artifactId: artifact.artifactId });
  const credential = await api(`/api/collaborations/${contextual.id}/credentials`, {
    ownerParticipantId: contextual.participantId, recipientParticipantId: contextual.participantId,
    name: "仅合成凭据申请元数据", type: "api-token", purpose: "上下文测试，不包含任何凭据明文",
  });
  const acceptance = await api(`/api/collaborations/${contextual.id}/acceptance`, {
    participantId: contextual.participantId, status: "failed", summary: "合成失败证据，用于验证上下文传播", evidence: { fixture: true, exitCode: 1 },
  });
  await fixture(provider, { message: "已复用完整上下文" });
  await execute(provider);
  const observed = JSON.parse(await readFile(join(provider.root, "observed.json"), "utf8"));
  assert.equal(observed.jobId, queued.jobs[0]);
  assert.ok(observed.instructions.some((message: any) => message.body === originalInstruction));
  assert.ok(!observed.messages.some((message: any) => message.body === originalInstruction), "old instruction must survive outside the recent-message window");
  assert.ok(observed.artifacts.some((item: any) => item.id === artifact.artifactId));
  assert.ok(observed.proposals.some((item: any) => item.id === proposal.id));
  assert.ok(observed.credentialRequests.some((item: any) => item.id === credential.id));
  assert.ok(observed.acceptanceRuns.some((item: any) => item.id === acceptance.id));
  assert.ok(observed.credentialRequests.every((item: any) => !("ciphertext" in item) && !("value" in item)));
  checks.push("领取时刷新产物、提案、凭据元数据、验收、真实jobId，并保留30条窗口前的用户约束");

  const ongoing = await createCollaboration(provider, "运行期间接续指令");
  await api(`/api/collaborations/${ongoing.id}/messages`, { body: "先检查缺失的合成参数" });
  await fixture(provider, { message: "旧执行轮次需要参数", waitForRelease: true, needsHumanInput: true });
  const firstExecution = execute(provider);
  const started = await waitUntilStarted(provider);
  const answer = await api(`/api/collaborations/${ongoing.id}/messages`, { body: "参数已补充：使用fixture，不要再次索取" })
    .finally(() => writeFile(join(provider.root, "release.json"), "{}"));
  assert.ok(answer.jobs.includes(started.jobId), "an in-flight instruction should coalesce with the current batch");
  await firstExecution;
  const resumed = await jobs(ongoing.id);
  const next = resumed.find((job) => job.status === "pending");
  assert.ok(next, "an answer received during execution must run after the old needsHumanInput result");
  assert.notEqual((next.payload as any).workflow.id, (resumed[0]!.payload as any).workflow.id);
  assert.equal((next.payload as any).workflow.round, 1, "a new explicit instruction gets a fresh bounded budget");
  await fixture(provider, { message: "合成参数已收到并处理" });
  await execute(provider);
  assert.ok((await jobs(ongoing.id)).every((job) => job.status === "completed"));
  checks.push("运行期间补充信息合流后续接，不被旧needsHumanInput吞掉，并重置有界预算");

  const passive = await createCollaboration(provider, "运行期间仅留言");
  await api(`/api/collaborations/${passive.id}/messages`, { body: "执行一次合成检查" });
  await fixture(provider, { message: "一次检查完成", waitForRelease: true });
  const passiveExecution = execute(provider);
  await waitUntilStarted(provider);
  await api(`/api/collaborations/${passive.id}/messages`, { body: "补充背景，不额外派发", dispatch: false })
    .finally(() => writeFile(join(provider.root, "release.json"), "{}"));
  await passiveExecution;
  assert.equal((await jobs(passive.id)).length, 1, "a passive comment during execution must not create another batch");
  checks.push("运行期间仅留言不会被误判为新执行指令");

  const dependency = await createCollaboration(provider, "依赖与动作回滚");
  const prerequisite = await api(`/api/collaborations/${dependency.id}/work-items`, { operation: "create", title: "部署核验" });
  const dependent = await api(`/api/collaborations/${dependency.id}/work-items`, { operation: "create", title: "依赖部署的完整联调", dependsOn: [prerequisite.id] });
  const blocked = await expectStatus(`/api/collaborations/${dependency.id}/work-items`, { operation: "update", workItemId: dependent.id, status: "in_progress" }, 409);
  assert.match(blocked.error.message, /部署核验/);
  const independent = await api(`/api/collaborations/${dependency.id}/work-items`, { operation: "create", title: "可独立完成的本地开发" });
  await api(`/api/collaborations/${dependency.id}/work-items`, { operation: "update", workItemId: independent.id, status: "in_progress" });
  await api(`/api/collaborations/${dependency.id}/messages`, { body: "故意提交合法产物后触发依赖冲突，验证整个动作批次回滚" });
  await fixture(provider, { actions: [
    { type: "artifact.upsert", title: "应被回滚的产物", artifactType: "markdown", content: "该合法动作不得在随后依赖冲突后残留" },
    { type: "work.update", workItemId: dependent.id, status: "in_progress" },
  ] });
  await execute(provider);
  const rollback = await detail(dependency.id);
  assert.ok(!rollback.artifacts.some((item: any) => item.title === "应被回滚的产物"));
  assert.ok((await jobs(dependency.id)).every((job) => job.status === "failed"));
  assert.ok(rollback.jobs.some((job: any) => job.status === "failed" && job.error.includes("前置任务")), "durable failure must be visible in the normal detail response");
  assert.ok(rollback.messages.some((message: any) => message.body.includes("执行失败")), "a failed last job must produce a visible stop reason");
  checks.push("依赖返回具体409、独立开发继续、动作失败整批回滚并显示失败和停止原因");

  const foreign = await createCollaboration(provider, "跨协作隔离目标");
  const foreignWork = await api(`/api/collaborations/${foreign.id}/work-items`, { operation: "create", title: "其他协作任务" });
  await expectStatus(`/api/collaborations/${dependency.id}/work-items`, { operation: "update", workItemId: foreignWork.id, status: "in_progress" }, 404);
  await expectStatus(`/api/collaborations/${dependency.id}/work-items`, { operation: "create", title: "非法跨协作依赖", dependsOn: [foreignWork.id] }, 422);
  await api(`/api/collaborations/${dependency.id}/messages`, { body: "验证Agent不能提交其他协作的验收" });
  await fixture(provider, { actions: [{ type: "acceptance.submit", workItemId: foreignWork.id, status: "passed", summary: "故意无效的跨协作合成验收", evidence: { fixture: true } }] });
  await execute(provider);
  const foreignAfter = await detail(foreign.id);
  assert.equal(foreignAfter.workItems[0].status, "pending");
  assert.equal(foreignAfter.acceptanceRuns.length, 0);
  assert.equal((await jobs(dependency.id)).at(-1)!.status, "failed");
  checks.push("HTTP任务/依赖及Agent验收跨协作拒绝，其他协作无变化");

  const lease = await createCollaboration(provider, "领取代际隔离");
  const leaseDispatch = await api(`/api/collaborations/${lease.id}/messages`, { body: "测试租约重领后的旧回执拒绝" });
  const firstClaim = await api("/api/connectors/poll", { agentId: provider.agent.id, waitMs: 0 }, provider.agent.token);
  assert.equal(firstClaim.job.id, leaseDispatch.jobs[0]);
  await db.update(connectorJobs).set({ leaseUntil: new Date(Date.now() - 1000) }).where(eq(connectorJobs.id, firstClaim.job.id));
  const secondClaim = await api("/api/connectors/poll", { agentId: provider.agent.id, waitMs: 0 }, provider.agent.token);
  assert.equal(secondClaim.job.attempts, firstClaim.job.attempts + 1);
  const stale = await raw("/api/connectors/complete", {
    agentId: provider.agent.id, jobId: firstClaim.job.id, attempts: firstClaim.job.attempts,
    status: "completed", result: { agentTurn: { message: "旧租约不得发布", actions: [] } },
  }, provider.agent.token);
  assert.equal(stale.response.status, 409);
  await db.update(connectorJobs).set({ leaseUntil: new Date(Date.now() - 1000) }).where(eq(connectorJobs.id, firstClaim.job.id));
  await fixture(provider, { message: "新租约真实Connector完成" });
  await execute(provider);
  const leaseRows = await jobs(lease.id);
  assert.equal(leaseRows[0]!.status, "completed");
  assert.equal(leaseRows[0]!.attempts, 3);
  assert.ok(!(await detail(lease.id)).messages.some((message: any) => message.body === "旧租约不得发布"));
  checks.push("过期租约重领、旧attempt回执409拒绝、新Connector代际完成");

  const localTest = await createCollaboration(provider, "无关联产物的本地测试");
  process.env.SEAM_TEST_COMMAND = `${JSON.stringify(process.execPath)} -e "console.log('synthetic workflow check passed')"`;
  const testJob = await api(`/api/collaborations/${localTest.id}/test-runs`, { participantId: localTest.participantId });
  await execute(provider);
  const localTestAfter = await detail(localTest.id);
  assert.equal((await jobs(localTest.id)).find((job) => job.id === testJob.id)!.status, "completed");
  assert.equal(localTestAfter.acceptanceRuns[0].status, "passed");
  assert.equal(localTestAfter.acceptanceRuns[0].evidence.exitCode, 0);
  checks.push("真实Connector本地测试、null关联字段兼容与退出码证据回传");

  const reporting = await createCollaboration(provider, "测试报告不作废既有契约");
  const contract = await api(`/api/collaborations/${reporting.id}/artifacts`, {
    title: "已冻结的合成API契约", type: "openapi",
    content: JSON.stringify({ openapi: "3.1.0", info: { title: "Synthetic fixture", version: "1.0.0" }, paths: { "/fixture": { post: {} } } }),
  });
  const agreement = await api(`/api/collaborations/${reporting.id}/proposals`, {
    operation: "create", title: "冻结合成API契约", body: "只冻结接口产物，不冻结后续测试报告",
    artifactId: contract.artifactId, approvalMode: "all",
  });
  await api(`/api/collaborations/${reporting.id}/proposals`, {
    operation: "decide", proposalId: agreement.id, participantId: reporting.participantId, decision: "approved",
  });
  const verifiedWork = await api(`/api/collaborations/${reporting.id}/work-items`, {
    operation: "create", title: "真实执行合成契约检查", assigneeParticipantId: reporting.participantId,
  });
  await api(`/api/collaborations/${reporting.id}/test-runs`, {
    participantId: reporting.participantId, workItemId: verifiedWork.id, artifactId: contract.artifactId,
  });
  await execute(provider);
  const assertFrozenAgreement = async () => {
    const current = await detail(reporting.id);
    assert.equal(current.proposals.find((item: any) => item.id === agreement.id).status, "accepted", "test reports must preserve the accepted contract proposal");
    assert.equal(current.workItems.find((item: any) => item.id === verifiedWork.id).status, "completed", "test reports must not reopen an accepted task");
    assert.equal(current.collaboration.status, "completed", "report publication must preserve completed collaboration status");
    return current;
  };
  await assertFrozenAgreement();
  const report = await api(`/api/collaborations/${reporting.id}/artifacts`, {
    title: "独立合成测试报告", type: "test-report", content: "首次合成检查退出码0；仅证明本地Connector测试链路",
  });
  await assertFrozenAgreement();
  const updatedReportContent = "追加回归摘要：合成检查退出码0；不改变冻结的API契约";
  await api(`/api/collaborations/${reporting.id}/artifacts`, {
    artifactId: report.artifactId, title: "独立合成测试报告", type: "test-report", content: updatedReportContent,
  });
  const beforeDuplicate = await assertFrozenAgreement();
  const duplicateArtifact = await api(`/api/collaborations/${reporting.id}/artifacts`, {
    title: "独立合成测试报告", type: "test-report", content: updatedReportContent,
  });
  assert.equal(duplicateArtifact.unchanged, true);
  assert.equal(duplicateArtifact.artifactId, report.artifactId, "an identical create must reuse the existing artifact");
  const afterDuplicate = await assertFrozenAgreement();
  assert.equal(afterDuplicate.artifacts.length, beforeDuplicate.artifacts.length);
  assert.equal(afterDuplicate.artifacts.find((item: any) => item.id === report.artifactId).versions.length, 2);
  assert.equal(afterDuplicate.messages.length, beforeDuplicate.messages.length, "an unchanged create must not add a misleading publication message");
  checks.push("已接受契约与真实验收任务不被报告创建/更新作废，同内容创建去重且不增版本或通知");

  // This negative test intentionally sends duplicate completion frames to the
  // real HTTP endpoint; successful ordinary execution above uses runConnector.
  const concurrent = await createCollaboration(provider, "重复完成回执并发隔离");
  const concurrentDispatch = await api(`/api/collaborations/${concurrent.id}/messages`, { body: "验证同一领取代际的并发完成回执只应用一次" });
  const concurrentClaim = await api("/api/connectors/poll", { agentId: provider.agent.id, waitMs: 0 }, provider.agent.token);
  assert.equal(concurrentClaim.job.id, concurrentDispatch.jobs[0]);
  const completionFrame = {
    agentId: provider.agent.id, jobId: concurrentClaim.job.id, attempts: concurrentClaim.job.attempts, status: "completed",
    result: { agentTurn: { message: "并发回执只应用一次", kind: "status", actions: [{ type: "work.create", title: "并发创建应仅有一个任务" }], notifyParticipantIds: [], needsHumanInput: false } },
  };
  const completions = await Promise.all([
    raw("/api/connectors/complete", completionFrame, provider.agent.token),
    raw("/api/connectors/complete", completionFrame, provider.agent.token),
  ]);
  assert.deepEqual(completions.map((result) => result.response.status).sort((left, right) => left - right), [200, 409]);
  const concurrentAfter = await detail(concurrent.id);
  assert.equal(concurrentAfter.workItems.length, 1);
  assert.equal(concurrentAfter.messages.filter((message: any) => message.metadata.jobId === concurrentClaim.job.id).length, 1);
  assert.equal((await jobs(concurrent.id))[0]!.status, "completed");
  checks.push("真实MySQL并发重复complete仅一次生效，第二回执409且无重复任务或消息");

  assert.equal((await db.select().from(connectorJobs).where(and(eq(connectorJobs.agentId, provider.agent.id), eq(connectorJobs.status, "running")))).length, 0);
  console.log(JSON.stringify({ ok: true, suite: "local workflow integration", runId, checks,
    scope: "真实HTTP/MySQL/Connector/子进程；AI采用确定性合成fixture，不代表双方业务E2E或真实模型验收", }, null, 2));
}

main().catch((error) => {
  console.error(JSON.stringify({ ok: false, suite: "local workflow integration", checks, error: error instanceof Error ? error.message : String(error) }, null, 2));
  process.exitCode = 1;
}).finally(async () => {
  await pool.end();
  if (temporaryRoot) await rm(temporaryRoot, { recursive: true, force: true });
});
