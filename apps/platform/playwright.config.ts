import { defineConfig } from "@playwright/test";

const configuredURL = process.env.SEAM_E2E_BASE_URL ?? process.env.SEAM_SIMULATION_URL ?? process.env.SEAM_APP_URL;
const baseURL = configuredURL ?? "http://localhost:3000";

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  workers: 1,
  timeout: 60_000,
  outputDir: "../../output/playwright/test-results",
  use: {
    baseURL,
    channel: "chrome",
    // Docker renders in UTC. Deliberately use the local timezone so date text
    // must remain stable through hydration rather than hiding a mismatch.
    timezoneId: "Asia/Shanghai",
    trace: "retain-on-failure",
  },
  // An explicitly supplied address belongs to an existing isolated deployment.
  // Never build/start a second server on port 3000 while testing Docker :13079.
  webServer: configuredURL ? undefined : {
    command: "pnpm build && pnpm start",
    url: "http://localhost:3000/api/health",
    reuseExistingServer: true,
    timeout: 120_000,
  },
});
