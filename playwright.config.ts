import { defineConfig } from "@playwright/test";

/**
 * Phase 0 acceptance — every route at the three phone viewports, signed
 * out. Runs against a dev server it starts on 4551, or against whatever
 * PW_BASE_URL points at (a running dev server, a preview deployment).
 *
 * Chromium only: the checks are layout and copy, which the engines render
 * alike, and the one browser is what CI has.
 */
const base = process.env.PW_BASE_URL ?? "http://localhost:4551";

/** PW_CHANNEL=chrome drives the machine's own Chrome when the Playwright build can't be fetched. */
const channel = process.env.PW_CHANNEL || undefined;

const desk = (width: number, height: number) => ({
  browserName: "chromium" as const,
  ...(channel ? { channel } : {}),
  viewport: { width, height },
  deviceScaleFactor: 1,
});

const phone = (width: number, height: number) => ({
  browserName: "chromium" as const,
  ...(channel ? { channel } : {}),
  viewport: { width, height },
  deviceScaleFactor: 2,
  isMobile: true,
  hasTouch: true,
  userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
});

export default defineConfig({
  testDir: "tests",
  timeout: 120_000,
  expect: { timeout: 20_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"]],
  outputDir: "test-results",
  use: { baseURL: base, trace: "retain-on-failure", screenshot: "only-on-failure" },
  projects: [
    { name: "unit", testMatch: /tests\/unit\/.*\.spec\.ts$/ },
    /* The timed run's UI half opens a page: the desktop mount at the board's
       width (design/particl-v2, 1440), and the same channel as the rest. */
    { name: "onboarding", testMatch: /tests\/onboarding\.spec\.ts$/, use: desk(1440, 900) },
    { name: "phone-360x640", testMatch: /tests\/(mobile|screens)\.spec\.ts$/, use: phone(360, 640) },
    { name: "phone-390x844", testMatch: /tests\/(mobile|screens)\.spec\.ts$/, use: phone(390, 844) },
    { name: "phone-844x390", testMatch: /tests\/(mobile|screens)\.spec\.ts$/, use: phone(844, 390) },
    /* Desktop is the shape, the phone is the floor (brief rule 7, revised).
       Three widths because the failures are at the column breaks, not in
       between: a laptop, a common desktop, and a 4K panel. */
    { name: "desktop-1440", testMatch: /tests\/desktop\.spec\.ts$/, use: desk(1440, 900) },
    { name: "desktop-1920", testMatch: /tests\/desktop\.spec\.ts$/, use: desk(1920, 1080) },
    { name: "desktop-2560", testMatch: /tests\/desktop\.spec\.ts$/, use: desk(2560, 1440) },
  ],
  webServer: process.env.PW_BASE_URL ? undefined : {
    command: "npm run dev -- -p 4551",
    url: "http://localhost:4551/welcome",
    reuseExistingServer: true,
    timeout: 180_000,
  },
});
