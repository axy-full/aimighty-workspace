import { defineConfig } from "@playwright/test";
import { sizeProjects } from "./tests/helpers/ownerSizes";

/*
 * The redesign's screenshot runs (docs/redesign-plan.md › "Screenshots"): each built screen beside its prototype URL
 * at the seven captures the owner reviews (tests/helpers/ownerSizes.ts; 2560x1440 at a pixel ratio of 1 and of 2, 3008x1692 at 2, as
 * `redesign-2560x1440`, `redesign-2560x1440@2x` and `redesign-3008x1692@2x`). Needs a local ENGINE_MOCK=1 server at PW_BASE_URL, like the workbench
 * suite. Not part of CI: the lead runs it per PR and attaches the images.
 */
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
  projects: sizeProjects("redesign"),
});
