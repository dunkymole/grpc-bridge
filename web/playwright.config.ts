import { defineConfig, devices } from "@playwright/test";

const baseURL = process.env.BROWSER_BASE_URL ?? "http://localhost:18081";

export default defineConfig({
  testDir: "./browser-tests",
  outputDir: "./test-results/browser-artifacts",
  timeout: 90_000,
  expect: { timeout: 15_000 },
  workers: 1,
  fullyParallel: false,
  reporter: [
    ["list"],
    ["json", { outputFile: "./test-results/browser-report.json" }],
  ],
  use: {
    baseURL,
    trace: "retain-on-failure",
  },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
    { name: "firefox", use: { ...devices["Desktop Firefox"] } },
    { name: "webkit", use: { ...devices["Desktop Safari"] } },
  ],
});
