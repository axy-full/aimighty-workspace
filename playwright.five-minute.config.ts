import { defineConfig } from "@playwright/test";

/**
 * The five-minute test (docs/plans/u1-ease.md § 3.1; scope v2 § 2 "Done when"): a new person with an invitation reaches
 * an approved first render, mocked, on a laptop and on a phone. Its own config, kept out of the workbench and customer
 * shards: it signs a person up and runs the whole path, so it wants a warm server and one worker.
 *
 *   ENGINE_MOCK=1 PW_BASE_URL=http://localhost:<port> PW_PLATFORM_DATABASE_URL=file:<that server's platform.db> \
 *     npx playwright test --config=playwright.five-minute.config.ts
 *
 * The global set-up first walks one throwaway person through the same path (not timed) so a cold dev server has
 * compiled every route the timed run uses. Local, mocked servers only: the spec refuses anything else.
 */
export default defineConfig({
  testDir: "tests",
  testMatch: /five-minute\.spec\.ts$/,
  globalSetup: "./tests/five-minute.warmup.ts",
  timeout: 150_000,
  expect: { timeout: 20_000 },
  workers: 1,
  retries: 0,
  reporter: "list",
  outputDir: "../five-minute-test-results",
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
  projects: [
    { name: "five-minute-desktop", use: { browserName: "chromium", viewport: { width: 1440, height: 900 } } },
    { name: "five-minute-phone", use: { browserName: "chromium", viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true } },
  ],
});
