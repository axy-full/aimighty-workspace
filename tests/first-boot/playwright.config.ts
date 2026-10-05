import { defineConfig } from "@playwright/test";

/**
 * A server's first start, in its own process: run only by tests/unit/ledgerFirstBoot.spec.ts, one
 * case per process, so no module (the platform client, billingReady) is cached from another test.
 */
export default defineConfig({
  testDir: ".",
  testMatch: /.*\.boot\.ts$/,
  timeout: 60_000,
  workers: 1,
  reporter: [["line"]],
});
