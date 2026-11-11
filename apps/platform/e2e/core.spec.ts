import { test, expect, type Page } from "@playwright/test";

const email = process.env.SEAM_E2E_EMAIL ?? process.env.SEAM_SIMULATION_EMAIL ?? "owner@seam.test";
const password = process.env.SEAM_E2E_PASSWORD ?? process.env.SEAM_SIMULATION_PASSWORD ?? "SeamTest!12345";
const pageErrors = new WeakMap<Page, string[]>();

test.beforeEach(async ({ page }) => {
  const errors: string[] = [];
  pageErrors.set(page, errors);
  page.on("pageerror", (error) => errors.push(error.message));
});

test.afterEach(async ({ page }) => {
  expect(pageErrors.get(page), "Browser page errors, including recovered hydration errors").toEqual([]);
});

test.beforeAll(async ({ request }) => {
  const response = await request.post("/api/setup", {
    data: { name: "Seam 测试所有者", email, password, organizationName: "Seam 测试组织" },
  });
  if (response.status() === 409) {
    expect((await request.post("/api/auth/login", { data: { email, password } })).ok()).toBeTruthy();
  } else expect(response.ok()).toBeTruthy();
});

test("登录、创建项目与 Agent、发起协作", async ({ page }) => {
  await page.goto("/login");
  await page.getByLabel("邮箱").fill(email);
  await page.getByLabel("密码").fill(password);
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await expect(page).toHaveURL(/\/collaborations/);

  const suffix = Date.now();
  await page.goto("/projects");
  await page.getByPlaceholder("例如：订单前端").fill(`浏览器验证项目 ${suffix}`);
  await page.locator('textarea[name="description"]').fill("Playwright 私有项目");
  await page.getByRole("button", { name: "创建项目", exact: true }).click();
  await expect(page.getByText(`浏览器验证项目 ${suffix}`, { exact: true }).last()).toBeVisible();

  await page.locator('select[name="projectId"]').selectOption({ label: `浏览器验证项目 ${suffix}` });
  await page.getByPlaceholder("backend-ai").fill(`ui-mock-${suffix}`);
  await page.locator('select[name="adapter"]').selectOption("mock");
  const agentResponse = page.waitForResponse((response) => response.url().endsWith("/api/agents") && response.request().method() === "POST");
  await page.getByRole("button", { name: "生成 Connector 凭据" }).click();
  await expect(page.getByText("Agent Token 只显示这一次，请立即保存。")).toBeVisible();
  const { agent } = await (await agentResponse).json();
  const targetProjectResponse = await page.request.post("/api/projects", { data: { name: `浏览器对接项目 ${suffix}`, description: "独立的合成对端" } });
  expect(targetProjectResponse.ok()).toBeTruthy();
  const { project: targetProject } = await targetProjectResponse.json();
  const targetAgentResponse = await page.request.post("/api/agents", { data: { projectId: targetProject.id, name: `peer-mock-${suffix}`, adapter: "mock" } });
  expect(targetAgentResponse.ok()).toBeTruthy();
  const { agent: targetAgent } = await targetAgentResponse.json();
  for (const connected of [agent, targetAgent]) {
    const heartbeat = await page.request.post("/api/connectors/heartbeat", { data: { agentId: connected.id }, headers: { authorization: `Bearer ${connected.token}` } });
    expect(heartbeat.ok()).toBeTruthy();
  }

  await page.goto("/collaborations");
  await page.getByRole("button", { name: "新建协作", exact: true }).click();
  const objective = `验证 Web 简洁创建与双方自动协商 ${suffix}`;
  await page.locator('textarea[name="objective"]').fill(objective);
  await page.locator('select[name="projectId"]').selectOption({ label: `浏览器验证项目 ${suffix}` });
  await page.locator('select[name="targetProjectId"]').selectOption(targetProject.id);
  await page.getByRole("button", { name: "提交目标，开始自动协商" }).click();
  await expect(page).toHaveURL(/\/collaborations\/[0-9a-f-]+/);
  await expect(page.getByRole("heading", { name: objective, exact: true })).toBeVisible();
  await expect(page.getByText("参与项目", { exact: true })).toBeVisible();
  const panel = page.getByRole("region", { name: "自动对接流程" });
  await expect(panel.getByRole("heading", { name: "自动对接 · 第 1 轮" })).toBeVisible();
  await expect(panel.getByText("此阶段为只读。", { exact: false })).toBeVisible();
  await expect(page.getByRole("button", { name: "确认文档并执行" })).toHaveCount(0);
  const detail = await (await page.request.get(`/api/collaborations/${page.url().split("/").at(-1)}`)).json();
  expect(detail.participants.filter((row: any) => row.participant.status === "active")).toHaveLength(2);
  expect(detail.jobs.filter((job: any) => job.status === "pending")).toHaveLength(2);
  expect(detail.lifecycle.phase).toBe("planning");
});
