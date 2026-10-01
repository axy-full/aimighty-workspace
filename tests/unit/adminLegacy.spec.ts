import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";

/**
 * The house workspace (lib/houseWorkspace.ts) is never billed in credits: a
 * grant or an allowance means nothing there. Its other settings — suspend,
 * limits, flags, its plan, and whether it is the platform's internal test
 * workspace — must still apply (tests/unit/adminDeletedWorkspace.spec.ts
 * drives them), or the previews batch has nowhere to run on a deployment whose
 * only workspace is the studio's. Every other workspace is funded from the
 * desk, legacy flag or not, and none may switch away from managed billing.
 */
test("the house guard covers the money settings only, reads the named rule, and runs before any write", () => {
  const source = readFileSync("app/api/admin/workspaces/[id]/route.ts", "utf8");
  const guard = source.slice(source.indexOf("if (isHouseWorkspace(ws)"), source.indexOf("const out: Record<string, unknown>"));
  expect(guard).toContain('"grantCredits"');
  expect(guard).toContain('"allowanceUsd"');
  expect(guard).toContain("HOUSE_NOT_BILLED");
  for (const other of ["internalTest", "suspended", "limits", "flagged", "planId"]) expect(guard).not.toContain(other);
  /* The rule is the named one, never the legacy flag. */
  expect(source).not.toMatch(/ws\.legacy/);
  // The guard must read the body, so it cannot fire before there is one to read.
  expect(source.indexOf("const body = await req.json")).toBeLessThan(source.indexOf("if (isHouseWorkspace(ws)"));
  expect(source.indexOf("if (isHouseWorkspace(ws)")).toBeLessThan(source.indexOf('if ("suspended" in body)'));
  expect(source).toContain('body.mode !== "platform"');
  expect(source.indexOf('body.mode !== "platform"')).toBeLessThan(source.indexOf('if ("grantCredits" in body)'));
});
