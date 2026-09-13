import { test, expect } from "@playwright/test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { grantBudgetMath, grantBudgetRoom, grantBudgetSpentLine } from "../../lib/adminView";
import { cleanCaps, DEFAULT_CAPS, mergeLayer } from "../../lib/platformLayer";

/**
 * §7A guardrail 1: invite approvals are capped per month by a platform
 * setting. The arithmetic is pure — what one grant is worth, what this cycle
 * has granted, what the open codes will add — and the budget is the layer's.
 */
const dir = mkdtempSync(path.join(tmpdir(), "particl-grant-"));
process.env.PLATFORM_DATABASE_URL = `file:${path.join(dir, "platform.db")}`;
process.env.TURSO_DATABASE_URL = `file:${path.join(dir, "primary.db")}`;
process.env.KEYRING_SECRET ??= "unit-test-keyring-secret-unit-test-keyring";
process.env.CREDIT_USD = "0.10";

test("one grant is the welcome credits at the rate; committed is granted plus the open codes", () => {
  const s = grantBudgetMath({ grantCredits: 250, creditUsd: 0.10, welcomeCreditsThisCycle: 4100, openCodesThisCycle: 3, budgetUsd: 1000 });
  expect(s.usdEach).toBeCloseTo(25, 9);
  expect(s.grantedUsd).toBeCloseTo(410, 9);
  expect(s.committedUsd).toBeCloseTo(485, 9);
  expect(s.budgetUsd).toBe(1000);
  expect(s.grantCredits).toBe(250);
  /* Decision 1 (docs/sow-surfaces-plan.md): the grant is read, never typed — 50 or 250 changes every figure and nothing else. */
  const fifty = grantBudgetMath({ grantCredits: 50, creditUsd: 0.10, welcomeCreditsThisCycle: 4100, openCodesThisCycle: 3, budgetUsd: 1000 });
  expect(fifty.usdEach).toBeCloseTo(5, 9);
  expect(fifty.committedUsd).toBeCloseTo(425, 9);
});

test("room: any number of codes without a budget; inside the budget with one; the 409 sentence when spent", () => {
  const open = grantBudgetMath({ grantCredits: 250, creditUsd: 0.10, welcomeCreditsThisCycle: 0, openCodesThisCycle: 0, budgetUsd: null });
  expect(grantBudgetRoom(open, 1000)).toBe(true);
  const s = grantBudgetMath({ grantCredits: 250, creditUsd: 0.10, welcomeCreditsThisCycle: 9000, openCodesThisCycle: 2, budgetUsd: 1000 });
  expect(s.committedUsd).toBeCloseTo(950, 9);
  expect(grantBudgetRoom(s, 2)).toBe(true);   // 950 + 50 = 1000, exactly the budget
  expect(grantBudgetRoom(s, 3)).toBe(false);  // 1025
  expect(grantBudgetRoom(s, 0)).toBe(true);
  expect(grantBudgetSpentLine(s, "September")).toBe("The grant budget for September is spent: $950 of $1,000 committed.");
  const nothing = grantBudgetMath({ grantCredits: 0, creditUsd: 0.10, welcomeCreditsThisCycle: 0, openCodesThisCycle: 5, budgetUsd: 0 });
  expect(nothing.usdEach).toBe(0);
  expect(grantBudgetRoom(nothing, 10)).toBe(true); // a free grant commits nothing
});

test("the budget is a cap on the layer: a non-negative number or nothing", () => {
  expect(DEFAULT_CAPS.grantBudgetUsd).toBeNull();
  expect(cleanCaps({ grantBudgetUsd: "1000" }).grantBudgetUsd).toBe(1000);
  expect(cleanCaps({ grantBudgetUsd: 12.345 }).grantBudgetUsd).toBe(12.35);
  expect(cleanCaps({ grantBudgetUsd: 0 }).grantBudgetUsd).toBe(0);
  expect(cleanCaps({ grantBudgetUsd: -5 }).grantBudgetUsd).toBeNull();
  expect(cleanCaps({ grantBudgetUsd: "" }).grantBudgetUsd).toBeNull();
  expect(cleanCaps({}).grantBudgetUsd).toBeNull();
  expect(mergeLayer({ caps: { grantBudgetUsd: 500, warnPct: 80 } }).caps.grantBudgetUsd).toBe(500);
});

test("grantBudgetState reads the grant, this cycle's welcome rows and the open codes from the record", async () => {
  const { grantBudgetState, welcomeGrantsSince, openInviteCodesSince, welcomeGrant, setPlatformLayer, platformDb, platformReady } = await import("../../lib/platform");
  const { cycleBounds } = await import("../../lib/cycle");
  await platformReady();
  const nowMs = Date.now();
  const { start } = cycleBounds(1, nowMs);
  const p = platformDb();
  const ins = (id: string, credits: number, kind: string, at: number) => p.execute({
    sql: `INSERT INTO credit_grants (id, workspace_id, credits, note, kind, created_by, created_at) VALUES (?,?,?,?,?,?,?)`,
    args: [id, "ws_g", credits, "t", kind, null, at],
  });
  await ins("cg_a", 250, "welcome", start + 1);
  await ins("cg_b", 250, "welcome", Math.max(0, start - 1)); // last cycle: out
  await ins("cg_c", 500, "purchase", start + 2);              // bought: not a grant
  await ins("cg_d", 100, "manual", start + 3);                // an admin's: not the welcome budget
  const inv = (code: string, at: number, used: number | null, expires: number) => p.execute({
    sql: `INSERT INTO signup_invites (code, email, name, note, created_by, created_at, expires_at, used_at) VALUES (?,?,?,?,?,?,?,?)`,
    args: [code, "a@b.c", "", "", null, at, expires, used],
  });
  await inv("open", start + 1, null, nowMs + 86400_000);
  await inv("used", start + 1, start + 2, nowMs + 86400_000);
  await inv("expired", start + 1, null, nowMs - 1);
  await inv("older", Math.max(0, start - 1), null, nowMs + 86400_000);
  expect(await welcomeGrantsSince(start)).toBe(250);
  expect(await openInviteCodesSince(start)).toBe(1);
  await setPlatformLayer("caps", { grantBudgetUsd: 100 }, "test");
  const grant = await welcomeGrant();
  const s = await grantBudgetState(nowMs);
  expect(s.grantCredits).toBe(grant);
  expect(s.usdEach).toBeCloseTo(grant * 0.10, 9);
  expect(s.grantedUsd).toBeCloseTo(25, 9);
  expect(s.committedUsd).toBeCloseTo(25 + grant * 0.10, 9);
  expect(s.budgetUsd).toBe(100);
});
