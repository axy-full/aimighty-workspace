import { test, expect } from "@playwright/test";
import { spawnSync } from "node:child_process";
import path from "node:path";

/**
 * The merge deploy of the conversion, end to end (lib/ledgerUnit.ts seedLedgerUnit, owner's order of
 * 5 October 2026): CREDIT_USD already 0.10 over a record the $0.80 build wrote. Each case runs in a
 * fresh process (tests/first-boot), as a server's first start does, so nothing is cached from
 * another unit file.
 */
for (const mode of ["window", "none"] as const) {
  test(`merged with CREDIT_USD=0.10: ${mode === "window" ? "a row from the $0.80 days pauses the very first paid request" : "no row from the $0.80 days, and the first paid request runs at $0.10"}`, () => {
    test.setTimeout(120_000);
    const env: NodeJS.ProcessEnv = { ...process.env, CASE: mode, CREDIT_USD: "0.10", ENGINE_MOCK: "1" };
    delete env.PLATFORM_DATABASE_URL;
    delete env.TURSO_DATABASE_URL;
    const run = spawnSync(path.resolve("node_modules/.bin/playwright"), ["test", "--config=tests/first-boot/playwright.config.ts"], { env, encoding: "utf8", timeout: 110_000 });
    expect(run.status, `${run.stdout}\n${run.stderr}`).toBe(0);
    expect(run.stdout).toMatch(/1 passed/);
  });
}
