import { CONNECTOR_PROTOCOL_VERSION } from "@seam/protocol";
import { capturePublicScreenshot } from "../../../scripts/evidence/public_screenshot.mjs";
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

test("登录、创建项目与 Agent、发起协作", async ({ page }, testInfo) => {
  await page.goto("/login");
  await page.getByLabel("邮箱").fill(email);
  await page.getByLabel("密码").fill(password);
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await expect(page).toHaveURL(/\/collaborations/);

  const suffix = Date.now();
  const projectName = `浏览器验证项目 ${suffix}`;
  await page.goto("/projects");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.getByRole("textbox")).toHaveCount(0);
  const newProject = page.getByRole("button", { name: "新建项目" });
  await newProject.click();
  const createDialog = page.getByRole("dialog", { name: "新建项目" });
  await expect(createDialog.getByLabel("项目名称")).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(newProject).toBeFocused();
  await newProject.click();
  await createDialog.getByLabel("项目名称").fill(projectName);
  await createDialog.getByLabel("说明（选填）").fill("Playwright 私有项目");
  await createDialog.getByRole("button", { name: "创建项目" }).click();
  await expect(createDialog).toHaveCount(0);
  const projectRow = page.getByRole("listitem").filter({ has: page.getByRole("heading", { name: projectName, exact: true }) });
  await expect(projectRow).toBeVisible();

  const targetProjectResponse = await page.request.post("/api/projects", { data: { name: `浏览器对接项目 ${suffix}`, description: "独立的合成对端" } });
  expect(targetProjectResponse.ok()).toBeTruthy();
  const { project: targetProject } = await targetProjectResponse.json();
  await page.reload();
  const register = projectRow.getByRole("button", { name: "注册 Agent" });
  await register.click();
  const registerDialog = page.getByRole("dialog", { name: "注册 Agent" });
  await expect(registerDialog.getByText(projectName, { exact: true })).toBeVisible();
  await registerDialog.getByLabel("Agent 名称").fill(`ui-mock-${suffix}`);
  await registerDialog.getByLabel("适配器").selectOption("mock");
  const agentResponse = page.waitForResponse((response) => response.url().endsWith("/api/agents") && response.request().method() === "POST");
  await registerDialog.getByRole("button", { name: "生成 Connector 凭据" }).click();
  const credentials = page.getByRole("dialog", { name: "Connector 凭据" });
  await expect(credentials.getByText("Agent Token 只显示这一次，请立即保存。")).toBeVisible();
  const { agent } = await (await agentResponse).json();
  await expect(credentials.locator("[data-sensitive]")).toBeVisible();
  const config = credentials.getByLabel("Connector 配置");
  const platformLine = (await config.inputValue()).split("\n").find((line) => line.startsWith("SEAM_PLATFORM_URL="));
  expect(platformLine).toBe(`SEAM_PLATFORM_URL=${new URL(page.url()).origin}`);
  await capturePublicScreenshot(page,testInfo.outputPath("credential-panel-masked.png"),{fullPage:true});
  // A LAN HTTP origin may have no Clipboard API. Check its manual-copy path.
  await page.evaluate(() => {
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: undefined });
  });
  await credentials.getByRole("button", { name: "复制配置" }).click();
  await expect(config).toBeFocused();
  expect(await config.evaluate((node: HTMLTextAreaElement) => node.selectionStart === 0 && node.selectionEnd === node.value.length)).toBe(true);
  await credentials.getByRole("button", { name: "已保存，关闭" }).click();
  await expect(register).toBeFocused();
  await expect(page.locator("[data-sensitive]")).toHaveCount(0);
  await expect(projectRow.getByText("1 个 Agent")).toBeVisible();
  await projectRow.getByRole("button", { name: "项目详情" }).click();
  await expect(projectRow.getByText(agent.name, { exact: true })).toBeVisible();
  const targetAgentResponse = await page.request.post("/api/agents", { data: { projectId: targetProject.id, name: `peer-mock-${suffix}`, adapter: "mock" } });
  expect(targetAgentResponse.ok()).toBeTruthy();
  const { agent: targetAgent } = await targetAgentResponse.json();
  for (const connected of [agent, targetAgent]) {
    const heartbeat = await page.request.post("/api/connectors/heartbeat", { data: { agentId: connected.id, capabilities: { adapter: "mock", executionMode: "external", testConfigured: false, supportsInformationLookup: true, protocolVersion: CONNECTOR_PROTOCOL_VERSION } }, headers: { authorization: `Bearer ${connected.token}` } });
    expect(heartbeat.ok()).toBeTruthy();
  }

  await page.goto("/collaborations");
  await page.getByRole("button", { name: "新建协作", exact: true }).click();
  const objective = `验证 Web 简洁创建与双方自动协商 ${suffix}`;
  await page.locator('textarea[name="objective"]').fill(objective);
  await page.locator('select[name="projectId"]').selectOption({ label: projectName });
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
