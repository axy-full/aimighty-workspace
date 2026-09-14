import { test, expect } from "@playwright/test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
const dir = mkdtempSync(path.join(tmpdir(), "particl-management-credits-"));
process.env.PLATFORM_DATABASE_URL = `file:${path.join(dir, "platform.db")}`;
process.env.TURSO_DATABASE_URL = `file:${path.join(dir, "primary.db")}`;
process.env.KEYRING_SECRET = "unit-test-keyring-secret-unit-test-keyring";

test("the first management purchase starts its expiry at granting, before any balance page is opened", async () => {
  const { grantCredits, platformDb } = await import("../../lib/platform");
  const { billingStateFor, addBillingMonths } =
    await import("../../lib/billingLedger");
  await grantCredits("new-house", 100, "Paid purchase", "admin", "purchase");
  const lot = (
    await platformDb().execute(
      `SELECT * FROM billing_lots WHERE workspace_id='new-house'`,
    )
  ).rows[0];
  expect(lot.legacy).toBe(0);
  expect(Number(lot.clock_started_at)).toBe(Number(lot.created_at));
  expect(Number(lot.expires_at)).toBe(
    addBillingMonths(Number(lot.created_at), 12),
  );
  // A customer who first opens billing thirteen months later cannot restart the clock.
  expect(
    (
      await billingStateFor(
        "new-house",
        addBillingMonths(Number(lot.created_at), 13),
      )
    ).credits.balance,
  ).toBe(0);
});

test("management purchase and bonus grants commit with their ledger lots or roll back together", async () => {
  const { grantCreditsBatch, platformDb } = await import("../../lib/platform");
  const { billingReady, billingStateFor } =
    await import("../../lib/billingLedger");
  await billingReady();
  const p = platformDb();
  await p.execute(
    `CREATE TRIGGER fail_management_bonus BEFORE INSERT ON credit_grants WHEN NEW.workspace_id='batch-house' AND NEW.kind='bonus' BEGIN SELECT RAISE(ABORT,'test bonus failure'); END`,
  );
  const rows = [
    {
      workspaceId: "batch-house",
      credits: 100,
      note: "Paid",
      by: "admin",
      kind: "purchase" as const,
    },
    {
      workspaceId: "batch-house",
      credits: 10,
      note: "Bonus",
      by: "admin",
      kind: "bonus" as const,
    },
  ];
  await expect(grantCreditsBatch(rows)).rejects.toThrow("test bonus failure");
  expect(
    (
      await p.execute(
        `SELECT * FROM credit_grants WHERE workspace_id='batch-house'`,
      )
    ).rows,
  ).toHaveLength(0);
  expect(
    (
      await p.execute(
        `SELECT * FROM billing_lots WHERE workspace_id='batch-house'`,
      )
    ).rows,
  ).toHaveLength(0);
  await p.execute("DROP TRIGGER fail_management_bonus");
  await grantCreditsBatch(rows);
  const state = await billingStateFor("batch-house");
  expect(state.credits.balance).toBe(110);
  expect(state.lots.every((l) => l.expiresAt != null && !l.legacy)).toBe(true);
});
