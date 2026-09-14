import { test, expect } from "@playwright/test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const dir = mkdtempSync(path.join(tmpdir(), "particl-billing-"));
process.env.PLATFORM_DATABASE_URL = `file:${path.join(dir, "platform.db")}`;
process.env.TURSO_DATABASE_URL = `file:${path.join(dir, "tenant.db")}`;
process.env.KEYRING_SECRET ??= "unit-test-keyring-secret-unit-test-keyring";
process.env.CREDIT_USD = "0.10";
process.env.ENGINE_MOCK = "1";
const day = 86_400_000;
const t = Date.UTC(2027, 0, 31, 12);

async function grant(
  ws: string,
  id: string,
  credits: number,
  kind = "purchase",
  at = t,
) {
  const { platformDb, platformReady } = await import("../../lib/platform");
  await platformReady();
  await platformDb().execute({
    sql: `INSERT INTO credit_grants(id,workspace_id,credits,kind,created_at) VALUES(?,?,?,?,?)`,
    args: [id, ws, credits, kind, at],
  });
}

async function debit(
  ws: string,
  id: string,
  credits: number,
  at = t,
  allowDebt = false,
) {
  const { billingTransaction, syncBillingLedger, setCreditDebitTx } =
    await import("../../lib/billingLedger");
  await billingTransaction(async (tx) => {
    await syncBillingLedger(tx, ws, at);
    await setCreditDebitTx(tx, ws, id, credits, at, allowDebt);
  }, at);
}

async function invoice(
  ws: string,
  at = t,
  interval: "month" | "year" = "month",
) {
  const { applyPaidSubscriptionPeriod, addBillingMonths } =
    await import("../../lib/billingLedger");
  const input = {
    workspaceId: ws,
    provider: "test",
    subscriptionId: `sub_${ws}`,
    invoiceId: `invoice_${ws}_${at}`,
    planId: "studio" as const,
    interval,
    includedCredits: 400,
    periodStart: at,
    periodEnd: addBillingMonths(at, interval === "year" ? 12 : 1),
    paidUsd: interval === "year" ? 470.4 : 49,
  };
  await applyPaidSubscriptionPeriod(input, at);
  return input;
}

test("legacy grant and meter migration preserves the full balance without retroactive expiry", async () => {
  const { platformDb } = await import("../../lib/platform");
  const { billingStateFor } = await import("../../lib/billingLedger");
  await grant("legacy", "legacy_pack", 100, "purchase", 0);
  await grant("legacy", "legacy_adjustment", -5, "manual", 0);
  await platformDb()
    .execute(`INSERT INTO meter_events(id,workspace_id,kind,engine,model,status,engine_cost_usd,billed_credits,paid_by_platform,created_at,updated_at)
    VALUES('legacy_job','legacy','video','byteplus','mock','succeeded',1,20,1,0,0)`);
  const before = await billingStateFor("legacy", t);
  expect(before.credits.balance).toBe(75);
  expect(before.lots.find((l) => l.id === "legacy_pack")?.expiresAt).toBeNull();
  expect((await billingStateFor("legacy", t + 900 * day)).credits.balance).toBe(
    75,
  );
});

test("confirmed monthly invoices grant once, isolate tenants, and expire without rollover", async () => {
  const { applyPaidSubscriptionPeriod, billingStateFor } =
    await import("../../lib/billingLedger");
  const input = await invoice("monthly");
  await applyPaidSubscriptionPeriod(input, t);
  expect((await billingStateFor("monthly", t)).credits.includedBalance).toBe(
    400,
  );
  expect(
    (await billingStateFor("monthly", input.periodEnd)).credits.balance,
  ).toBe(0);
  expect(
    (await billingStateFor("monthly", input.periodEnd)).credits.expiredCredits,
  ).toBe(400);
  await expect(
    applyPaidSubscriptionPeriod({ ...input, workspaceId: "other" }, t),
  ).rejects.toThrow("different billing terms");
  expect((await billingStateFor("other", t)).credits.balance).toBe(0);
});

test("annual payment opens monthly windows at the original month-end anchor, never 12 months upfront", async () => {
  const { billingStateFor, addBillingMonths } =
    await import("../../lib/billingLedger");
  await invoice("annual", t, "year");
  expect(new Date(addBillingMonths(t, 1)).toISOString()).toBe(
    "2027-02-28T12:00:00.000Z",
  );
  expect(new Date(addBillingMonths(t, 2)).toISOString()).toBe(
    "2027-03-31T12:00:00.000Z",
  );
  expect((await billingStateFor("annual", t)).credits.balance).toBe(400);
  const later = await billingStateFor("annual", addBillingMonths(t, 5));
  expect(later.cycles).toHaveLength(6);
  expect(later.credits.balance).toBe(400);
  expect(later.credits.expiredCredits).toBe(2000);
  expect(
    (await billingStateFor("annual", addBillingMonths(t, 12))).credits.balance,
  ).toBe(0);
});

test("included credits fund first; correcting a reservation restores its original lots without resurrecting expired credits", async () => {
  const { billingStateFor } = await import("../../lib/billingLedger");
  const { platformDb } = await import("../../lib/platform");
  await grant("order", "order_pack", 100);
  const paid = await invoice("order");
  await debit("order", "order_job", 450);
  const allocations = await platformDb().execute(
    `SELECT l.kind,a.credits FROM billing_allocations a JOIN billing_lots l ON l.id=a.lot_id WHERE a.event_id='order_job'`,
  );
  expect(
    Object.fromEntries(
      allocations.rows.map((r) => [r.kind, Number(r.credits)]),
    ),
  ).toEqual({ included: 400, purchase: 50 });
  await debit("order", "order_job", 300, paid.periodEnd, true);
  const state = await billingStateFor("order", paid.periodEnd);
  expect(state.credits.purchasedBalance).toBe(100);
  expect(state.credits.includedBalance).toBe(0);
  expect(state.credits.expiredCredits).toBe(100);
  expect(state.credits.balance).toBe(100);
  await debit("order", "order_job", 300, paid.periodEnd, true);
  expect((await billingStateFor("order", paid.periodEnd)).credits.balance).toBe(
    100,
  );
});

test("concurrent ledger reservations cannot draw the same lot", async () => {
  const { billingStateFor } = await import("../../lib/billingLedger");
  await grant("race", "race_pack", 100);
  const result = await Promise.allSettled([
    debit("race", "race_a", 70),
    debit("race", "race_b", 70),
  ]);
  expect(result.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  expect((await billingStateFor("race", t)).credits.balance).toBe(30);
});

test("actual provider overrun remains debt and blocks another reservation", async () => {
  const { billingStateFor } = await import("../../lib/billingLedger");
  await grant("debt", "debt_pack", 100);
  await debit("debt", "debt_job", 100);
  await debit("debt", "debt_job", 120, t, true);
  expect((await billingStateFor("debt", t)).credits.balance).toBe(-20);
  await expect(debit("debt", "debt_extra", 1)).rejects.toThrow("available");
  await debit("debt", "debt_job", 90, t, true);
  expect((await billingStateFor("debt", t)).credits.balance).toBe(10);
});

test("new purchased credits expire after 12 off-plan months; a paid year pauses and cancellation resumes remaining time", async () => {
  const { billingStateFor, addBillingMonths, updateSubscriptionStatus } =
    await import("../../lib/billingLedger");
  await billingStateFor("clock", t);
  await grant("clock", "clock_pack", 100);
  const initial = await billingStateFor("clock", t);
  expect(initial.lots[0].expiresAt).toBe(addBillingMonths(t, 12));
  const paid = await invoice("clock", t + 30 * day, "year");
  await updateSubscriptionStatus(
    {
      workspaceId: "clock",
      subscriptionId: paid.subscriptionId,
      status: "active",
      cancelAtPeriodEnd: true,
    },
    t + 31 * day,
  );
  expect(
    (await billingStateFor("clock", t + 200 * day)).lots.find(
      (l) => l.id === "clock_pack",
    )?.expiresAt,
  ).toBeNull();
  const after = await billingStateFor("clock", paid.periodEnd);
  const expected =
    addBillingMonths(t, 12) + (paid.periodEnd - paid.periodStart);
  expect(after.lots.find((l) => l.id === "clock_pack")?.expiresAt).toBe(
    expected,
  );
  expect(
    (await billingStateFor("clock", expected)).credits.purchasedBalance,
  ).toBe(0);
});

test("a delayed paid invoice protects elapsed paid time even if the pack clock was read before its webhook", async () => {
  const { billingStateFor, applyPaidSubscriptionPeriod, addBillingMonths } =
    await import("../../lib/billingLedger");
  await billingStateFor("delayed", t);
  await grant("delayed", "delayed_pack", 100);
  await billingStateFor("delayed", t);
  await billingStateFor("delayed", t + 60 * day);
  await applyPaidSubscriptionPeriod(
    {
      workspaceId: "delayed",
      provider: "test",
      subscriptionId: "delayed_sub",
      invoiceId: "delayed_invoice",
      planId: "studio",
      interval: "year",
      includedCredits: 400,
      periodStart: t + 30 * day,
      periodEnd: addBillingMonths(t + 30 * day, 12),
      paidUsd: 470.4,
    },
    t + 60 * day,
  );
  const resumed = await billingStateFor(
    "delayed",
    addBillingMonths(t + 30 * day, 12),
  );
  expect(resumed.lots.find((l) => l.id === "delayed_pack")?.expiresAt).toBe(
    addBillingMonths(t, 12) +
      (addBillingMonths(t + 30 * day, 12) - t - 30 * day),
  );
});

test("verified refund claws back its original lot, records spent credits as debt, and replays exactly once", async () => {
  const { reverseCreditGrant, billingStateFor } =
    await import("../../lib/billingLedger");
  await grant("refund", "refund_pack", 100);
  await debit("refund", "refund_job", 80);
  const reversal = {
    workspaceId: "refund",
    refundId: "refund_1",
    grantId: "refund_pack",
    credits: 100,
  };
  await reverseCreditGrant(reversal, t);
  await reverseCreditGrant(reversal, t);
  expect((await billingStateFor("refund", t)).credits.balance).toBe(-80);
  expect((await billingStateFor("refund", t)).credits.granted).toBe(0);
  await expect(
    reverseCreditGrant({ ...reversal, credits: 50 }, t),
  ).rejects.toThrow("different credits");
  await debit("refund", "refund_job", 0, t, true);
  expect((await billingStateFor("refund", t)).credits.balance).toBe(0);
});

test("a reversed annual invoice cannot materialize future credit windows", async () => {
  const { reversePaidSubscriptionPeriod, billingStateFor, addBillingMonths } =
    await import("../../lib/billingLedger");
  const paid = await invoice("invoice_refund", t, "year");
  await reversePaidSubscriptionPeriod(
    {
      workspaceId: paid.workspaceId,
      invoiceId: paid.invoiceId,
      refundId: "invoice_refund_1",
    },
    t + day,
  );
  const later = await billingStateFor("invoice_refund", addBillingMonths(t, 4));
  expect(later.credits.balance).toBe(0);
  expect(later.cycles).toHaveLength(1);
  expect(later.subscription?.status).toBe("unpaid");
});

test("topup status and both grants roll back together, then a retried approval grants exactly once", async () => {
  const { platformDb } = await import("../../lib/platform");
  const { decideTopupCredits } = await import("../../lib/topups");
  const { billingStateFor } = await import("../../lib/billingLedger");
  await platformDb()
    .execute(`INSERT INTO topup_requests(id,workspace_id,pack_id,label,credits,bonus_credits,usd,status,created_at)
    VALUES('atomic_topup','topup_workspace','team','Team',2000,200,200,'requested',0)`);
  await platformDb().execute(
    `CREATE TRIGGER fail_topup_bonus BEFORE INSERT ON credit_grants WHEN NEW.id='topup:atomic_topup:bonus' BEGIN SELECT RAISE(ABORT,'test storage failure'); END`,
  );
  await expect(
    decideTopupCredits({ id: "atomic_topup", action: "approve", by: "admin" }),
  ).rejects.toThrow("test storage failure");
  expect(
    (
      await platformDb().execute(
        `SELECT status FROM topup_requests WHERE id='atomic_topup'`,
      )
    ).rows[0].status,
  ).toBe("requested");
  expect(
    (
      await platformDb().execute(
        `SELECT COUNT(*) AS n FROM credit_grants WHERE workspace_id='topup_workspace'`,
      )
    ).rows[0].n,
  ).toBe(0);
  await platformDb().execute(`DROP TRIGGER fail_topup_bonus`);
  const results = await Promise.all([
    decideTopupCredits({ id: "atomic_topup", action: "approve", by: "admin" }),
    decideTopupCredits({ id: "atomic_topup", action: "approve", by: "admin" }),
  ]);
  expect(results.filter((r) => r.changed)).toHaveLength(1);
  expect((await billingStateFor("topup_workspace")).credits.balance).toBe(2200);
  expect(
    (
      await platformDb().execute(
        `SELECT COUNT(*) AS n FROM credit_grants WHERE workspace_id='topup_workspace'`,
      )
    ).rows[0].n,
  ).toBe(2);
});

test("older paid invoices still grant their funded windows without regressing cancellation or a newer subscription", async () => {
  const {
    applyPaidSubscriptionPeriod,
    billingStateFor,
    updateSubscriptionStatus,
    addBillingMonths,
  } = await import("../../lib/billingLedger");
  const paid = await invoice("ordering");
  await updateSubscriptionStatus(
    {
      workspaceId: paid.workspaceId,
      subscriptionId: paid.subscriptionId,
      status: "canceled",
      cancelAtPeriodEnd: false,
      eventCreatedAt: t + 20 * day,
    },
    t + 20 * day,
  );
  await applyPaidSubscriptionPeriod(
    {
      ...paid,
      invoiceId: "older_order_invoice",
      periodStart: t - 20 * day,
      periodEnd: t,
      eventCreatedAt: t - 20 * day,
    },
    t + 21 * day,
  );
  expect(
    (await billingStateFor("ordering", t + 21 * day)).subscription?.status,
  ).toBe("canceled");
  await applyPaidSubscriptionPeriod(
    {
      ...paid,
      subscriptionId: "ordering_new_sub",
      invoiceId: "ordering_new_invoice",
      periodStart: t + 22 * day,
      periodEnd: addBillingMonths(t + 22 * day, 1),
      eventCreatedAt: t + 22 * day,
      planId: "agency",
      includedCredits: 1600,
      paidUsd: 199,
    },
    t + 22 * day,
  );
  await updateSubscriptionStatus(
    {
      workspaceId: paid.workspaceId,
      subscriptionId: paid.subscriptionId,
      status: "canceled",
      cancelAtPeriodEnd: true,
      eventCreatedAt: t + 23 * day,
    },
    t + 23 * day,
  );
  expect(
    (await billingStateFor("ordering", t + 23 * day)).subscription?.planId,
  ).toBe("agency");
  expect(
    (await billingStateFor("ordering", t + 23 * day)).subscription?.status,
  ).toBe("active");
});

test("paid entitlements end at the funded boundary and explicit legacy admin grants survive", async () => {
  const { paidPlanEntitlement, effectivePlanId } =
    await import("../../lib/billingLedger");
  const paid = await invoice("entitlement");
  const active = await paidPlanEntitlement("entitlement", paid.periodEnd - 1);
  expect(effectivePlanId(active, "invite")).toBe("studio");
  const expired = await paidPlanEntitlement("entitlement", paid.periodEnd);
  expect(effectivePlanId(expired, null)).toBe("invite");
  expect(effectivePlanId(expired, "production")).toBe("production");
  expect(
    effectivePlanId({ planId: null, subscribedBefore: false }, null),
  ).toBeNull();
});

test("rolling deployment meter corrections are reconciled without inventing historical source attribution", async () => {
  const { platformDb } = await import("../../lib/platform");
  const { billingStateFor, creditFundingFor } =
    await import("../../lib/billingLedger");
  await grant("rolling", "rolling_pack", 100);
  await platformDb().execute({
    sql: `INSERT INTO meter_events(id,workspace_id,kind,engine,model,status,billed_credits,paid_by_platform,created_at,updated_at) VALUES('rolling_job','rolling','video','byteplus','mock','running',50,1,?,?)`,
    args: [t, t],
  });
  expect((await billingStateFor("rolling", t)).credits.balance).toBe(50);
  await platformDb().execute(
    `UPDATE meter_events SET status='succeeded',billed_credits=30 WHERE id='rolling_job'`,
  );
  expect((await billingStateFor("rolling", t)).credits.balance).toBe(70);
  expect(await creditFundingFor("rolling", t, t + day)).toEqual([
    { eventId: "rolling_job", kind: "legacy", credits: 30 },
  ]);
});

test("account and billing transactions share a write queue and cannot interleave uncommitted changes", async () => {
  const { accountTransaction } = await import("../../lib/accountDb");
  const { billingStateFor, billingReady } =
    await import("../../lib/billingLedger");
  await billingReady();
  await grant("shared_lock", "shared_lock_pack", 100);
  const results = await Promise.all([
    debit("shared_lock", "shared_lock_job", 20),
    accountTransaction(async (tx) => {
      await tx.execute(
        `INSERT INTO account_action_limits(key,bucket,n) VALUES('shared-billing',0,1)`,
      );
    }),
    billingStateFor("shared_lock", t),
  ]);
  expect(results).toHaveLength(3);
  expect((await billingStateFor("shared_lock", t)).credits.balance).toBe(80);
});
