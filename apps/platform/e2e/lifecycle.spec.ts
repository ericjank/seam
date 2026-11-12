import { fixtureContract, fixtureRuns } from "../tests/fixtures/shared-contract";
import { randomUUID } from "node:crypto";
import { test, expect, type APIRequestContext, type Page } from "@playwright/test";

const email = process.env.SEAM_E2E_EMAIL ?? process.env.SEAM_SIMULATION_EMAIL ?? "owner@seam.test";
const password = process.env.SEAM_E2E_PASSWORD ?? process.env.SEAM_SIMULATION_PASSWORD ?? "SeamTest!12345";
type Agent = { id: string; token: string };
type Peer = { project: { id: string; name: string }; agent: Agent };
const pageErrors = new WeakMap<Page, string[]>();

test.beforeEach(async ({ page }) => {
  const errors: string[] = [];
  pageErrors.set(page, errors);
  page.on("pageerror", (error) => errors.push(error.message));
});

test.afterEach(async ({ page }) => {
  expect(pageErrors.get(page), "Browser page errors, including recovered hydration errors").toEqual([]);
});

async function post(request: APIRequestContext, path: string, data: unknown, agent?: Agent) {
  const response = await request.post(path, { data, ...(agent ? { headers: { authorization: `Bearer ${agent.token}` } } : {}) });
  expect(response.ok(), `${path}: ${await response.text()}`).toBeTruthy();
  return response.json();
}

async function signIn(page: Page, credentials = { email, password }) {
  await page.goto("/login");
  await page.getByLabel("邮箱").fill(credentials.email);
  await page.getByLabel("密码").fill(credentials.password);
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await expect(page).toHaveURL(/\/collaborations$/);
}

async function preparePeers(request: APIRequestContext, onlineBoth = true): Promise<Peer[]> {
  const peers: Peer[] = [];
  const suffix = randomUUID().slice(0, 8);
  for (const role of ["提供方", "消费方"]) {
    const { project } = await post(request, "/api/projects", { name: `浏览器生命周期${role}-${suffix}`, description: "只供浏览器验收的合成项目" });
    const { agent } = await post(request, "/api/agents", { projectId: project.id, name: `browser-${role}`, adapter: "mock" });
    peers.push({ project, agent });
  }
  for (const peer of onlineBoth ? peers : peers.slice(0, 1)) {
    await post(request, "/api/connectors/heartbeat", { agentId: peer.agent.id }, peer.agent);
  }
  return peers;
}

async function submitGoal(page: Page, peers: Peer[], objective: string) {
  await page.goto("/collaborations");
  await page.getByRole("button", { name: "新建协作", exact: true }).click();
  await page.locator('textarea[name="objective"]').fill(objective);
  await page.locator('select[name="projectId"]').selectOption(peers[0]!.project.id);
  await page.locator('select[name="targetProjectId"]').selectOption(peers[1]!.project.id);
  // Unique Agents are selected by the platform. No UUID or invitation form is filled.
  await page.getByRole("button", { name: "提交目标，开始自动协商" }).click();
}

async function completePhase(request: APIRequestContext, collaborationId: string, peers: Peer[], phase: string) {
  const detail = await (await request.get(`/api/collaborations/${collaborationId}`)).json();
  const targets = phase === "plan_synthesis" ? peers.filter((peer) => detail.participants.find((row: any) => row.participant.agentId === peer.agent.id)?.participant.id === detail.lifecycle.coordinatorParticipantId) : peers;
  for (const peer of targets) {
    const { job } = await post(request, "/api/connectors/poll", { agentId: peer.agent.id, waitMs: 0 }, peer.agent);
    expect(job?.collaborationId).toBe(collaborationId);
    expect(job.kind).toBe("collaboration.turn");
    const lifecycle = job.payload.context.lifecycle;
    expect(lifecycle.phase).toBe(phase);
    const revision = lifecycle.revision;
    const action = phase === "planning" ? {
      type: "plan.submit", revision,
      content: `# ${peer.project.name} 修订${revision}完整方案\n\n## 目标与接口\n使用合成POST /quote接口验证浏览器受控协作流程，不访问业务数据。当前管理员要求：${lifecycle.requirements}。\n\n## 分工与实施\n双方先确认相同文档hash，再由管理员批准。提供方校验SKU和数量，消费方验证金额和错误响应；修订2增加折扣兼容。不得在批准前创建代码、安装依赖、部署或调用实际业务服务。\n\n## 测试证据\n本浏览器场景以合成Connector HTTP回执验证文档、审批与报告展示，真实Codex及代码测试由独立完整模拟运行器验证。本回执不冒充真实模型实施或业务验收。`,
    } : phase === "plan_synthesis" ? {
      type: "plan.compose", revision, baseDocumentHash: lifecycle.documentHash, contract: fixtureContract(lifecycle.requiredParticipantIds, revision),
    } : phase === "plan_confirmation" ? {
      type: "plan.confirm", revision, documentHash: lifecycle.documentHash,
    } : phase === "joint_verifying" ? {
      type: "integration.report", revision, documentHash: lifecycle.documentHash, runs: fixtureRuns(job.id), checks: lifecycle.contract.acceptanceCases.filter((item: any) => item.runnerParticipantId === job.payload.context.participant.id).map((item: any) => ({ caseId: item.id, status: "passed", command: item.command, summary: "浏览器流程合成回执，不代表真实模型或业务验收", evidence: { fixture: true }, assertionNames: ["fixture HTTP contract"], runIds: [`fixture-${job.id}`] })),
    } : {
      type: "execution.report", revision, status: "passed",
      summary: `${peer.project.name} 修订${revision}浏览器流程合成回执，仅验证报告展示；不代表真实模型或业务验收。`,
      evidence: { fixture: true, command: "Playwright lifecycle.spec.ts 合成Connector回执", revision, browserAssertions: "actual UI and HTTP state transitions" },
    };
    await post(request, "/api/connectors/complete", { agentId: peer.agent.id, jobId: job.id, attempts: job.attempts,
      status: "completed", result: { agentTurn: { message: `${phase}浏览器合成回执`, kind: "status", actions: [action], notifyParticipantIds: [], needsHumanInput: false } },
    }, peer.agent);
  }
}

test.beforeAll(async ({ request }) => {
  const setup = await request.post("/api/setup", { data: { name: "Seam 浏览器管理员", email, password, organizationName: "Seam 浏览器测试" } });
  expect([201, 409]).toContain(setup.status());
});

test("管理员通过真实界面审阅两轮文档和报告，明确批准后执行并手动终止", async ({ page, browser }, testInfo) => {
  await signIn(page);
  const peers = await preparePeers(page.request);
  const objective = `验证双方报价协作的两轮管理员门控 ${randomUUID().slice(0, 8)}`;
  await submitGoal(page, peers, objective);
  await expect(page).toHaveURL(/\/collaborations\/[0-9a-f-]+$/);
  const id = page.url().split("/").at(-1)!;
  const panel = page.getByRole("region", { name: "自动对接流程" });
  await expect(panel.getByRole("heading", { name: "自动对接 · 第 1 轮" })).toBeVisible();
  await expect(panel.getByRole("button", { name: "确认文档并执行" })).toHaveCount(0);
  await expect(panel.getByRole("button", { name: "满意，确认终止任务" })).toHaveCount(0);
  await expect(page.locator('textarea[name="body"]')).toHaveCount(0);
  const bypassMessage = `不应被写入或派发的聊天旁路 ${randomUUID()}`;
  const bypass = await page.request.post(`/api/collaborations/${id}/messages`, { data: { body: bypassMessage } });
  expect(bypass.status()).toBe(409);
  const afterBypass = await (await page.request.get(`/api/collaborations/${id}`)).json();
  expect(afterBypass.messages.some((message: any) => message.body === bypassMessage)).toBe(false);
  expect(afterBypass.jobs).toHaveLength(2);
  const earlyTermination = await page.request.post(`/api/collaborations/${id}/lifecycle`, { data: { action: "terminate" } });
  expect(earlyTermination.status()).toBe(409);

  await panel.getByRole("button", { name: "暂停自动协作", exact: true }).click();
  await expect(panel.getByRole("button", { name: "恢复自动协作", exact: true })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("paused.png"), fullPage: true });
  await panel.getByRole("button", { name: "恢复自动协作", exact: true }).click();
  await completePhase(page.request, id, peers, "planning");
  await completePhase(page.request, id, peers, "plan_synthesis");
  await completePhase(page.request, id, peers, "plan_confirmation");
  await expect(panel.getByRole("heading", { name: "开发对接实施文档 · v1" })).toBeVisible({ timeout: 15_000 });
  await expect(panel.getByLabel("审阅摘要")).toContainText("验收用例 2");
  await expect(panel.getByText(/计划 2\/2 · 确认 2\/2 · 实施回执 0\/2/)).toBeVisible();
  await expect(panel.getByRole("button", { name: "确认文档并执行" })).toBeVisible();
  const versionOne = await (await page.request.get(`/api/collaborations/${id}`)).json();
  expect(versionOne.lifecycle.phase).toBe("awaiting_approval");
  expect(versionOne.jobs.filter((job: any) => ["pending", "running"].includes(job.status))).toHaveLength(0);
  await page.screenshot({ path: testInfo.outputPath("revision-1-awaiting-approval.png"), fullPage: true });

  const viewerEmail = `browser-viewer-${randomUUID()}@seam.test`;
  const viewerPassword = "BrowserViewer!2026";
  await post(page.request, "/api/users", { name: "浏览器只读成员", email: viewerEmail, password: viewerPassword, role: "viewer" });
  const viewerContext = await browser.newContext({ baseURL: testInfo.project.use.baseURL, timezoneId: "Asia/Shanghai" });
  try {
    const viewerPage = await viewerContext.newPage();
    viewerPage.on("pageerror", (error) => pageErrors.get(page)!.push(`viewer: ${error.message}`));
    await signIn(viewerPage, { email: viewerEmail, password: viewerPassword });
    await viewerPage.goto(`/collaborations/${id}`);
    const viewerPanel = viewerPage.getByRole("region", { name: "自动对接流程" });
    await expect(viewerPanel.getByRole("heading", { name: "开发对接实施文档 · v1" })).toBeVisible();
    await expect(viewerPanel.getByRole("button", { name: "确认文档并执行" })).toHaveCount(0);
    await expect(viewerPanel.getByRole("button", { name: "补充要求并重新起草" })).toHaveCount(0);
    const forbidden = await viewerPage.request.post(`/api/collaborations/${id}/lifecycle`, { data: { action: "approve", revision: 1, documentHash: versionOne.lifecycle.documentHash } });
    expect(forbidden.status()).toBe(403);
  } finally { await viewerContext.close(); }

  await panel.getByRole("button", { name: "确认文档并执行" }).click();
  await expect(panel.getByText("两端正在按已批准文档修改各自项目并运行测试", { exact: false })).toBeVisible();
  await completePhase(page.request, id, peers, "executing");
  { const beforeJoint = await (await page.request.get(`/api/collaborations/${id}`)).json();
  expect(beforeJoint.lifecycle.phase).toBe("joint_verifying");
  expect(beforeJoint.lifecycle.report).toBeNull(); }
  await completePhase(page.request, id, peers, "joint_verifying");
  await expect(panel.getByRole("heading", { name: "完整实施报告 · v1" })).toBeVisible({ timeout: 15_000 });
  await expect(panel.getByText(/实施回执 2\/2/)).toBeVisible();
  await expect(panel.locator("pre").last()).toContainText("不代表真实模型或业务验收");
  await expect(panel.getByRole("button", { name: "满意，确认终止任务" })).toBeVisible();
  expect((await (await page.request.get(`/api/collaborations/${id}`)).json()).lifecycle.phase).toBe("awaiting_review");
  const fixtureEvidence = "浏览器证据展示回执（非真实联合验收）";
  await post(page.request, `/api/collaborations/${id}/artifacts`, {
    title: fixtureEvidence, type: "test-report",
    content: JSON.stringify({ fixture: true, scope: "只检查补充证据在界面展示，不代表实际HTTP或模型实施通过" }),
  });
  const evidence = panel.locator("details").filter({ has: page.locator("summary", { hasText: fixtureEvidence }) });
  await expect(evidence.locator("pre")).toContainText("不代表实际HTTP或模型实施通过", { timeout: 15_000 });
  await expect(panel.getByRole("heading", { name: "完整实施报告 · v1" })).toBeVisible();

  await panel.locator('textarea[name="requirements"]').fill("增加折扣字段，保留修订1行为并补充错误边界测试");
  await panel.getByRole("button", { name: "补充要求并重新起草" }).click();
  await expect(panel.getByRole("heading", { name: "自动对接 · 第 2 轮" })).toBeVisible();
  await expect(panel.getByRole("heading", { name: "完整实施报告 · v1" })).toHaveCount(0);
  await expect(panel.getByRole("button", { name: "确认文档并执行" })).toHaveCount(0);
  const stale = await page.request.post(`/api/collaborations/${id}/lifecycle`, { data: { action: "approve", revision: 1, documentHash: versionOne.lifecycle.documentHash } });
  expect(stale.status()).toBe(409);
  await completePhase(page.request, id, peers, "planning");
  await completePhase(page.request, id, peers, "plan_synthesis");
  await completePhase(page.request, id, peers, "plan_confirmation");
  await expect(panel.getByRole("heading", { name: "开发对接实施文档 · v2" })).toBeVisible({ timeout: 15_000 });
  const differences = panel.getByLabel("本轮内容差异");
  await differences.locator("summary").first().click();
  await expect(differences).toContainText("接口 quote");
  await expect(differences).toContainText("discountPercent");
  await expect(differences).toContainText("上版");
  await panel.getByText("完整文档原文与指纹", { exact: true }).click();
  await expect(panel.locator("pre").filter({ hasText: "增加折扣字段" }).first()).toBeVisible();
  await panel.getByRole("button", { name: "确认文档并执行" }).click();
  await expect(panel.getByText("两端正在按已批准文档修改各自项目并运行测试", { exact: false })).toBeVisible();
  await completePhase(page.request, id, peers, "executing");
  { const beforeJoint = await (await page.request.get(`/api/collaborations/${id}`)).json();
  expect(beforeJoint.lifecycle.phase).toBe("joint_verifying");
  expect(beforeJoint.lifecycle.report).toBeNull(); }
  await completePhase(page.request, id, peers, "joint_verifying");
  await expect(panel.getByRole("heading", { name: "完整实施报告 · v2" })).toBeVisible({ timeout: 15_000 });
  await page.screenshot({ path: testInfo.outputPath("revision-2-full-report.png"), fullPage: true });
  await panel.getByRole("button", { name: "满意，确认终止任务" }).click();
  await expect(panel.getByText("管理员已终止此任务，文档、报告和对话记录已保留。", { exact: true })).toBeVisible();
  await expect(panel.getByRole("heading", { name: "开发对接实施文档 · v2" })).toBeVisible();
  await expect(panel.getByRole("heading", { name: "完整实施报告 · v2" })).toBeVisible();
  await expect(panel.getByRole("button", { name: "补充要求并重新起草" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "重试自动流程" })).toHaveCount(0);
  const terminated = await (await page.request.get(`/api/collaborations/${id}`)).json();
  expect(terminated.lifecycle.phase).toBe("terminated");
  expect(terminated.jobs.filter((job: any) => ["pending", "running"].includes(job.status))).toHaveLength(0);
});

test("必要事实阻塞有明确入口，补充后保留流程而无需重填项目资料", async ({ page }, testInfo) => {
  await signIn(page); const peers = await preparePeers(page.request);
  await submitGoal(page, peers, `阻塞事实恢复 ${randomUUID().slice(0,8)}`);
  await expect(page).toHaveURL(/\/collaborations\/[0-9a-f-]+$/);
  const id = page.url().split("/").at(-1)!, peer = peers[0]!;
  const { job } = await post(page.request, "/api/connectors/poll", { agentId: peer.agent.id, waitMs: 0 }, peer.agent);
  await post(page.request, "/api/connectors/complete", { agentId: peer.agent.id, jobId: job.id, attempts: job.attempts, status: "completed", result: { agentTurn: { message: "缺少测试服务绑定地址，需管理员补充必要事实。", needsHumanInput: true, actions: [] } } }, peer.agent);
  const panel = page.getByRole("region", { name: "自动对接流程" });
  await expect(panel.getByLabel("协作阻塞")).toContainText("需要补充事实", { timeout: 15000 });
  await expect(panel.getByRole("button", { name: "确认文档并执行" })).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath("necessary-fact-block.png"), fullPage: true });
  await panel.getByLabel("补充阻塞所缺的事实").fill("本地使用动态端口，仅通过本轮service.publish共享真实就绪地址。");
  await panel.getByRole("button", { name: "补充事实并继续" }).click();
  await expect(panel.getByLabel("协作阻塞")).toHaveCount(0, { timeout: 15000 });
  const detail = await (await page.request.get(`/api/collaborations/${id}`)).json();
  expect(detail.lifecycle.revision).toBe(1); expect(detail.lifecycle.phase).toBe("planning");
  expect(detail.messages.some((item:any) => item.metadata.blockResolution && item.body.includes("动态端口"))).toBe(true);
  await page.screenshot({ path: testInfo.outputPath("necessary-fact-resolved.png"), fullPage: true });
});

test("离线对端在界面显示明确阻塞，不创建半成品协作", async ({ page }) => {
  await signIn(page);
  const peers = await preparePeers(page.request, false);
  const objective = `离线对端阻塞测试 ${randomUUID().slice(0, 8)}`;
  await submitGoal(page, peers, objective);
  await expect(page.locator(".notice.error")).toContainText("请先启动双方本地 Connector 并确认在线");
  await expect(page).toHaveURL(/\/collaborations$/);
  const after = await (await page.request.get("/api/collaborations")).json();
  expect(after.collaborations.filter((row: any) => row.collaboration.objective === objective)).toHaveLength(0);
  await expect(page.locator('textarea[name="objective"]')).toHaveValue(objective);
});
