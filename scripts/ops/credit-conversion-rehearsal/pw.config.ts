import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: ".",
  testMatch: /.*\.rehearsal\.ts$/,
  timeout: 180_000,
  workers: 1,
  reporter: "line",
  outputDir: "../../../.data/pw-results/conv-rehearsal",
  use: { baseURL: process.env.PW_BASE_URL || "http://localhost:4620", channel: process.env.PW_CHANNEL || undefined },
});
