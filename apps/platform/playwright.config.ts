import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  workers: 1,
  timeout: 60_000,
  use: {
    baseURL: process.env.SEAM_APP_URL ?? "http://localhost:3000",
    channel: "chrome",
    trace: "retain-on-failure",
  },
  webServer: {
    command: "pnpm build && pnpm start",
    url: "http://localhost:3000/api/health",
    reuseExistingServer: true,
    timeout: 120_000,
  },
});
