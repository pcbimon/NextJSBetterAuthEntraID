import { defineConfig, devices } from "@playwright/test";

// Servers are started by scripts/e2e.mjs (npm run test:e2e), not by Playwright.
// One worker: all tests share the mock IdP, whose behavior is set per test.
export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  forbidOnly: true,
  reporter: [["list"]],
  timeout: 30_000,
  use: {
    ...devices["Desktop Chrome"],
    trace: "retain-on-failure",
  },
});
