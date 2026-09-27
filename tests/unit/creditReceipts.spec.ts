import { test, expect } from "@playwright/test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { TenantWorkspace } from "../../lib/tenant";

const directory = mkdtempSync(path.join(tmpdir(), "particl-receipts-"));
process.env.PLATFORM_DATABASE_URL = `file:${path.join(directory, "platform.db")}`;
process.env.TURSO_DATABASE_URL = `file:${path.join(directory, "legacy.db")}`;
process.env.KEYRING_SECRET = "mock-receipts-keyring-secret-for-tests";
const workspace = (id: string): TenantWorkspace => ({
  id, slug: id, name: id, dbUrl: `file:${path.join(directory, `${id}.db`)}`, dbToken: null,
  legacy: false, usesPlatformKeys: true, keys: {}, ownerId: "tester", createdAt: 0,
  allowanceUsd: null, gatewayKeyId: null, suspendedAt: null, suspendedReason: null,
  flaggedAt: null, flagNote: null, concurrency: null, rendersPerHour: null,
  storageQuotaBytes: null, deletedAt: null,
});

test("tenant projections preserve exact receipts, refunds and scope across rate changes and clock skew", async () => {
  const { runInTenant } = await import("../../lib/tenant");
  const { platformReady, platformDb } = await import("../../lib/platform");
  const { db, ready } = await import("../../lib/db");
  const { syncCreditReceipts } = await import("../../lib/creditReceipts");
  const { billedCreditsSum } = await import("../../lib/creditSql");
  await platformReady();
  for (const [id, ws, charged, paid] of [["old", "a", 7, 1], ["refunded", "a", 0, 1], ["historic_own", "a", 99, 0], ["private_b", "b", 19, 1]] as const) {
    await platformDb().execute({ sql: "INSERT INTO meter_events(id,workspace_id,kind,engine,model,status,engine_cost_usd,billed_credits,paid_by_platform,created_at,updated_at) VALUES(?,?,'video','byteplus','fixture','succeeded',1,?,?,1,10)", args: [id, ws, charged, paid] });
  }
  await runInTenant(workspace("a"), async () => {
    await ready();
    for (const id of ["old", "refunded", "historic_own", "unmetered"]) await db().execute({ sql: "INSERT INTO generations(id,model,prompt,params,status,created_at,updated_at,cost_usd) VALUES(?,'fixture','','{}','succeeded',1,10,1)", args: [id] });
    await syncCreditReceipts();
    expect((await db().execute("SELECT event_id,credits FROM credit_receipts ORDER BY event_id")).rows.map(r => [r.event_id, Number(r.credits)])).toEqual([["historic_own", 0], ["old", 7], ["refunded", 0]]);
    const original = process.env.CREDIT_USD;
    try {
      process.env.CREDIT_USD = "0.04";
      const sum = await db().execute(`SELECT ${billedCreditsSum()} AS total FROM generations`);
      expect(Number(sum.rows[0].total)).toBe(22); // One unmetered historical take keeps its previous terms.
      const { getGeneration } = await import("../../lib/jobs");
      const { exportRows } = await import("../../lib/exportRows");
      expect((await getGeneration("old"))?.creditsBilled).toBe(7);
      expect((await getGeneration("refunded"))?.creditsBilled).toBe(0);
      const exported = await exportRows();
      expect(exported.rows.find(row => row.id === "old")?.credits).toBe(7);
      expect(exported.rows.every(row => row.usd === 0)).toBe(true);

      const cursor = Number((await db().execute("SELECT revision FROM credit_receipt_cursor")).rows[0].revision);
      // Settlement arrives from a server whose wall clock is earlier.
      await platformDb().execute("UPDATE meter_events SET billed_credits=4,updated_at=2 WHERE id='old'");
      await syncCreditReceipts();
      expect(Number((await db().execute("SELECT credits FROM credit_receipts WHERE event_id='old'")).rows[0].credits)).toBe(4);
      expect(Number((await db().execute("SELECT revision FROM credit_receipt_cursor")).rows[0].revision)).toBeGreaterThan(cursor);
      const settled = Number((await db().execute("SELECT revision FROM credit_receipt_cursor")).rows[0].revision);
      await platformDb().execute("UPDATE meter_events SET billed_credits=4,updated_at=20 WHERE id='old'");
      await syncCreditReceipts();
      expect(Number((await db().execute("SELECT revision FROM credit_receipt_cursor")).rows[0].revision)).toBe(settled);
    } finally { if (original === undefined) delete process.env.CREDIT_USD; else process.env.CREDIT_USD = original; }
  });
  await runInTenant(workspace("b"), async () => {
    await syncCreditReceipts();
    expect((await db().execute("SELECT event_id FROM credit_receipts")).rows.map(r => r.event_id)).toEqual(["private_b"]);
  });
});

test("an interrupted projection resumes in bounded pages without losing later changes", async () => {
  const { platformReady, platformDb } = await import("../../lib/platform");
  const { runInTenant } = await import("../../lib/tenant");
  const { db } = await import("../../lib/db");
  const { syncCreditReceipts } = await import("../../lib/creditReceipts");
  await platformReady();
  await platformDb().batch(Array.from({ length: 405 }, (_, i) => ({ sql: "INSERT INTO meter_events(id,workspace_id,kind,engine,model,status,billed_credits,paid_by_platform,created_at,updated_at) VALUES(?,'pages','video','byteplus','fixture','succeeded',1,1,0,0)", args: [`page_${i}`] })), "write");
  await runInTenant(workspace("pages"), async () => {
    await syncCreditReceipts();
    expect(Number((await db().execute("SELECT SUM(credits) AS total FROM credit_receipts")).rows[0].total)).toBe(405);
    // Losing the cursor acknowledgement replays receipts safely.
    await db().execute("UPDATE credit_receipt_cursor SET revision=0");
    await platformDb().execute("UPDATE meter_events SET billed_credits=0 WHERE id='page_0'");
    await syncCreditReceipts();
    expect(Number((await db().execute("SELECT SUM(credits) AS total FROM credit_receipts")).rows[0].total)).toBe(404);
  });
});
