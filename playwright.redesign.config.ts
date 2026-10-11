import { defineConfig } from "@playwright/test";

/*
 * The redesign's screenshot runs (docs/redesign-plan.md › "Screenshots"): each built screen beside its prototype URL
 * at the two desktop sizes the owner reviews. Needs a local ENGINE_MOCK=1 server at PW_BASE_URL, like the workbench
 * suite. Not part of CI: the lead runs it per PR and attaches the images.
 */
const sizes = [
  [1440, 900],
  [1280, 800],
];
export default defineConfig({
  testDir: "tests/redesign",
  testMatch: /\.shots\.ts$/,
  timeout: 120_000,
  expect: { timeout: 15_000 },
  workers: 1,
  retries: 0,
  reporter: "list",
  outputDir: "../redesign-test-results",
  use: {
    baseURL: process.env.PW_BASE_URL || "http://localhost:4561",
    ...(process.env.PW_EXECUTABLE_PATH ? { launchOptions: { executablePath: process.env.PW_EXECUTABLE_PATH } } : {}),
  },
  projects: sizes.map(([width, height]) => ({
    name: `redesign-${width}x${height}`,
    use: { browserName: "chromium" as const, viewport: { width, height } },
  })),
});
