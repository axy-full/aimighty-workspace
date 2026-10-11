import { defineConfig } from "@playwright/test";

/**
 * The five-minute journey on the new screens (prototype 14), a new spec beside tests/five-minute.spec.ts. Same shape and
 * rules as playwright.five-minute.config.ts: local, mocked servers only, one worker, a warm server.
 */
export default defineConfig({
  testDir: "tests",
  testMatch: /five-minute-v14\.spec\.ts$/,
  globalSetup: "./tests/five-minute-v14.warmup.ts",
  timeout: 150_000,
  expect: { timeout: 20_000 },
  workers: 1,
  retries: 0,
  reporter: "list",
  outputDir: "../five-minute-v14-test-results",
  use: {
    baseURL: process.env.PW_BASE_URL || "http://localhost:4551",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    ...(process.env.PW_EXECUTABLE_PATH ? { launchOptions: { executablePath: process.env.PW_EXECUTABLE_PATH } } : process.env.PW_CHANNEL ? { channel: process.env.PW_CHANNEL } : {}),
  },
  projects: [
    { name: "five-minute-desktop", use: { browserName: "chromium", viewport: { width: 1440, height: 900 } } },
  ],
});
