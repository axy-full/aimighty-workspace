import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";

/**
 * The studio's own workspace is the platform: an allowance, a mode or a
 * credit grant means nothing there. Its other settings — suspend, limits,
 * flags, and whether it is the platform's internal test workspace — must
 * still apply, or the previews batch has nowhere to run on a deployment
 * whose only workspace is the studio's.
 */
test("the legacy guard covers the money settings only", () => {
  const src = readFileSync("app/api/admin/workspaces/[id]/route.ts", "utf8");
  const guard = src.slice(src.indexOf("const moneyKeys"), src.indexOf("if (\"suspended\" in body)"));
  expect(guard).toContain('"allowanceUsd"');
  expect(guard).toContain('"grantCredits"');
  expect(guard).toContain('"mode"');
  expect(guard).not.toContain("internalTest");
  expect(guard).not.toContain("suspended");
  // The guard must read the body, so it cannot fire before there is one to read.
  expect(src.indexOf("const body = await req.json")).toBeLessThan(src.indexOf("const moneyKeys"));
});
