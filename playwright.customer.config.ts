import { defineConfig } from "@playwright/test";
const sizes = [
  [360, 640],
  [390, 844],
  [844, 390],
  [1440, 900],
  [1920, 1080],
];
export default defineConfig({
  testDir: "tests",
  testMatch:
    /(gen|customer|composer-audio|composer-batch|paid-action|recovery-race|upload-recovery|workspace-audit|management-scope)\.spec\.ts$/,
  timeout: 90_000,
  expect: { timeout: 15_000 },
  workers: 1,
  retries: 0,
  reporter: "list",
  outputDir: "../customer-test-results",
  use: {
    baseURL: process.env.PW_BASE_URL || "http://localhost:4551",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    ...(process.env.PW_EXECUTABLE_PATH
      ? { launchOptions: { executablePath: process.env.PW_EXECUTABLE_PATH } }
      : process.env.PW_CHANNEL
        ? { channel: process.env.PW_CHANNEL }
        : {}),
  },
  projects: sizes.map(([width, height]) => ({
    name: `customer-${width}x${height}`,
    use: {
      browserName: "chromium" as const,
      viewport: { width, height },
      isMobile: width < 900,
      hasTouch: width < 900,
    },
  })),
});
