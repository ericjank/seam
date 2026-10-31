import { test, expect } from "@playwright/test";

test.beforeAll(async ({ request }) => {
  const response = await request.post("/api/setup", {
    data: { name: "Seam 测试所有者", email: "owner@seam.test", password: "SeamTest!12345", organizationName: "Seam 测试组织" },
  });
  if (response.status() === 409) {
    await request.post("/api/auth/login", { data: { email: "owner@seam.test", password: "SeamTest!12345" } });
  }
});

test("登录、创建项目与 Agent、发起协作", async ({ page }) => {
  await page.goto("/login");
  await page.getByLabel("邮箱").fill("owner@seam.test");
  await page.getByLabel("密码").fill("SeamTest!12345");
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
  await page.getByRole("button", { name: "生成 Connector 凭据" }).click();
  await expect(page.getByText("Agent Token 只显示这一次，请立即保存。")).toBeVisible();

  await page.goto("/collaborations");
  await page.getByRole("button", { name: "新建协作", exact: true }).click();
  await page.locator('input[name="title"]').fill(`浏览器协作 ${suffix}`);
  await page.locator('textarea[name="objective"]').fill("验证 Web 创建协作流程");
  await page.locator('select[name="projectId"]').selectOption({ label: `浏览器验证项目 ${suffix}` });
  await page.getByRole("button", { name: "创建并邀请参与方" }).click();
  await expect(page).toHaveURL(/\/collaborations\/[0-9a-f-]+/);
  await expect(page.getByRole("heading", { name: `浏览器协作 ${suffix}` })).toBeVisible();
  await expect(page.getByText("参与项目", { exact: true })).toBeVisible();
});
