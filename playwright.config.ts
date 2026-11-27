import { defineConfig, devices } from "@playwright/test";
import { E2E } from "./test/e2e/ports";

// Requires a production build first: `npm run build` (npm run test:e2e does both).
export default defineConfig({
  testDir: "test/e2e",
  testMatch: /.*\.spec\.ts$/,
  fullyParallel: false,
  workers: 1, // one shared stack with resettable state
  timeout: 30_000,
  expect: { timeout: 10_000 },
  reporter: [["list"]],
  use: {
    baseURL: E2E.baseUrl,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: "npx tsx test/e2e/stack.mts",
    url: `${E2E.baseUrl}/login`,
    timeout: 120_000,
    reuseExistingServer: false,
    stdout: "pipe",
    stderr: "pipe",
  },
});
