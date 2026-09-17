import { defineConfig } from "@playwright/test";
import base from "./playwright.workbench.config";
export default defineConfig({
  ...base,
  use: { ...base.use, actionTimeout: 12000 },
  outputDir: "../canvas-browser-results",
  projects: [
    ...base
      .projects!.filter(
        (p) => p.name?.startsWith("workbench-") && p.name !== "workbench-api",
      )
      .map((p) => ({ ...p, testMatch: /canvas-selection\.spec\.ts$/ })),
  ],
});
