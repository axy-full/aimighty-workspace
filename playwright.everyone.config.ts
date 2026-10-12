import { defineConfig } from "@playwright/test";

/*
 * The new interface for a workspace that is not the house workspace, photographed at the five sizes the owner reviews
 * (tests/redesign/everyone-sizes.shots.ts). Local ENGINE_MOCK server at PW_BASE_URL; not part of CI.
 */
const sizes = [[360, 640], [390, 844], [844, 390], [1440, 900], [1920, 1080]];
export default defineConfig({
  testDir: "tests/redesign",
  testMatch: /everyone-sizes\.shots\.ts$/,
  timeout: 240_000,
  expect: { timeout: 15_000 },
  workers: 1,
  retries: 0,
  reporter: "list",
  outputDir: "../redesign-test-results",
  use: { baseURL: process.env.PW_BASE_URL || "http://localhost:4561" },
  projects: sizes.map(([width, height]) => ({
    name: `everyone-${width}x${height}`,
    use: { browserName: "chromium" as const, viewport: { width, height }, isMobile: width < 900, hasTouch: width < 900 },
  })),
});
