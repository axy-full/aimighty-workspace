import { test, expect } from "@playwright/test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { TenantWorkspace } from "../../lib/tenant";

/**
 * Takes made before metering keep the figure frozen for them (lib/estimatedCredits.ts; owner, 14 Oct 2026: "pre-metering takes marked estimated, no repricing" and "freeze
 * 'estimated' figures in their own table"; docs/plans/step-0-data.md item 4, MIGRATION M2): filled once per workspace at today's terms, only for takes with no receipt that are not
 * newer than the workspace's first meter event, and read by every reader of a take's credits instead of computing it. Nothing is written to the meter, a receipt or a balance.
 */
const dir = mkdtempSync(path.join(tmpdir(), "particl-estimated-credits-"));
process.env.PLATFORM_DATABASE_URL = `file:${path.join(dir, "platform.db")}`;
process.env.TURSO_DATABASE_URL = `file:${path.join(dir, "primary.db")}`;
process.env.KEYRING_SECRET ??= "unit-test-keyring-secret-unit-test-keyring";
process.env.ENGINE_MOCK = "1";

const workspace = (id: string): TenantWorkspace => ({
  id, slug: id, name: id, dbUrl: `file:${path.join(dir, `${id}.db`)}`, dbToken: null, legacy: false, usesPlatformKeys: true, keys: {}, ownerId: "tester", createdAt: 0,
  allowanceUsd: null, gatewayKeyId: null, suspendedAt: null, suspendedReason: null, flaggedAt: null, flagNote: null, concurrency: null, rendersPerHour: null, storageQuotaBytes: null, deletedAt: null,
});
const MONTH_START = Date.UTC(2026, 8, 1);
const take = (id: string, at: number, cost: number, kind = "video", model = "dreamina-seedance-2-5-260628") => ({
  sql: "INSERT INTO generations(id,kind,model,prompt,params,status,created_at,updated_at,cost_usd) VALUES(?,?,?,'','{}','succeeded',?,?,?)", args: [id, kind, model, at, at, cost],
});

test("filled once, at today's figures, only for takes with no receipt that are not newer than the first meter event; a take made later is never frozen", async () => {
  const { runInTenant } = await import("../../lib/tenant");
  const { platformReady, platformDb } = await import("../../lib/platform");
  const { db, ready } = await import("../../lib/db");
  const { syncCreditReceipts } = await import("../../lib/creditReceipts");
  const { freezeEstimatesSql } = await import("../../lib/creditSql");
  await platformReady();
  /* The workspace's first meter event is at 1000; one take has a receipt. */
  await platformDb().batch([
    { sql: "INSERT INTO meter_events(id,workspace_id,kind,engine,model,status,engine_cost_usd,billed_credits,paid_by_platform,created_at,updated_at) VALUES('metered','ws_est','video','byteplus','dreamina-seedance-2-5-260628','succeeded',1,13,1,1000,1000)", args: [] },
    { sql: "INSERT INTO meter_events(id,workspace_id,kind,engine,model,status,engine_cost_usd,billed_credits,paid_by_platform,created_at,updated_at) VALUES('other','ws_other','video','byteplus','x','succeeded',1,99,1,10,10)", args: [] },
  ], "write");
  await runInTenant(workspace("ws_est"), async () => {
    await ready();
    await db().batch([take("old_a", 100, 1.0), take("old_b", 200, 0.134, "image", "gemini-3-pro-image"), take("old_zero", 300, 0), take("metered", 1000, 1.0), take("newer", 2000, 1.0)], "write");
    const expectedOldA = Number((await db().execute(`SELECT CAST(${freezeEstimatesSql("g")} AS INTEGER) AS c FROM generations g WHERE g.id='old_a'`)).rows[0].c);
    expect(expectedOldA).toBeGreaterThan(0);
    await syncCreditReceipts();
    const frozen = Object.fromEntries((await db().execute("SELECT gen_id, credits FROM estimated_credits ORDER BY gen_id")).rows.map((r) => [String(r.gen_id), Number(r.credits)]));
    expect(Object.keys(frozen)).toEqual(["old_a", "old_b", "old_zero"]);
    expect(frozen.old_a).toBe(expectedOldA);
    expect(frozen.old_zero).toBe(0);
    expect((await db().execute("SELECT first_meter_at FROM estimated_credits_fill WHERE id=1")).rows[0].first_meter_at).toBe(1000);
    /* A take made after the fill (no receipt yet) is never frozen, and the fill does not run again. */
    await db().execute(take("late", 50, 5));
    await syncCreditReceipts();
    expect((await db().execute("SELECT COUNT(*) AS n FROM estimated_credits")).rows[0].n).toBe(3);
    const { getGeneration } = await import("../../lib/jobs");
    expect((await getGeneration("old_a"))).toMatchObject({ creditsBilled: expectedOldA, estimated: true });
    expect((await getGeneration("metered"))).toMatchObject({ creditsBilled: 13, estimated: false });
    expect((await getGeneration("newer"))).toMatchObject({ creditsBilled: 0, estimated: false });
    expect((await getGeneration("late"))).toMatchObject({ creditsBilled: 0, estimated: false });
    /* The meter, the receipts and every balance are untouched. */
    expect(Number((await platformDb().execute("SELECT COUNT(*) AS n FROM meter_events WHERE workspace_id='ws_est'")).rows[0].n)).toBe(1);
    expect((await db().execute("SELECT event_id FROM credit_receipts")).rows.map((r) => r.event_id)).toEqual(["metered"]);
  });
});

test("a workspace with no meter event at all freezes every take it has, once", async () => {
  const { runInTenant } = await import("../../lib/tenant");
  const { db, ready } = await import("../../lib/db");
  const { syncCreditReceipts } = await import("../../lib/creditReceipts");
  await runInTenant(workspace("ws_est_empty"), async () => {
    await ready();
    await db().batch([take("a", 100, 1), take("b", 5_000_000_000_000, 1)], "write");
    await syncCreditReceipts();
    expect((await db().execute("SELECT gen_id FROM estimated_credits ORDER BY gen_id")).rows.map((r) => r.gen_id)).toEqual(["a", "b"]);
    expect((await db().execute("SELECT first_meter_at FROM estimated_credits_fill")).rows[0].first_meter_at).toBeNull();
  });
});

test("statements, caps and usage read the frozen figure for a take made before metering; the figure does not follow the margin table", async () => {
  const { runInTenant } = await import("../../lib/tenant");
  const { platformReady, platformDb } = await import("../../lib/platform");
  const { db, ready } = await import("../../lib/db");
  const { statementFor } = await import("../../lib/statements");
  const { spentBy } = await import("../../lib/caps");
  await platformReady();
  await platformDb().execute({ sql: "INSERT INTO meter_events(id,workspace_id,kind,engine,model,status,engine_cost_usd,billed_credits,paid_by_platform,created_at,updated_at) VALUES('m1','ws_est_read','video','byteplus','dreamina-seedance-2-5-260628','succeeded',1,13,1,?,?)", args: [MONTH_START + 5_000, MONTH_START + 5_000] });
  await runInTenant(workspace("ws_est_read"), async () => {
    await ready();
    await db().batch([
      { sql: "INSERT OR IGNORE INTO projects(id,name,created_at) VALUES('p','Board',0)", args: [] },
      { ...take("old", MONTH_START + 1_000, 1.0), sql: "INSERT INTO generations(id,kind,model,prompt,params,status,created_at,updated_at,cost_usd,project_id) VALUES(?,?,?,'','{}','succeeded',?,?,?,'p')" },
    ], "write");
    /* The reader that runs first does the fill. */
    const { syncCreditReceipts } = await import("../../lib/creditReceipts");
    await syncCreditReceipts();
    const frozen = Number((await db().execute("SELECT credits FROM estimated_credits WHERE gen_id='old'")).rows[0].credits);
    expect(frozen).toBeGreaterThan(0);
    /* The frozen row is the figure, whatever the margin table says now: change it and read again. */
    await db().execute("UPDATE estimated_credits SET credits = credits + 100 WHERE gen_id='old'");
    const statement = await statementFor("2026-09", null);
    const lines = statement!.projects.flatMap((p) => [...p.shots.flatMap((s) => s.lines), ...p.loose]);
    expect(lines.find((l) => l.id === "old")?.credits).toBe(frozen + 100);
    expect((await spentBy("project_id", ["p"])).get("p")?.credits).toBe(frozen + 100);
  });
});

test("no reader of a take's credits can reach today's margins: the cap baseline, the cap reader and the statement no longer price a take from its cost", () => {
  for (const file of ["lib/caps.ts", "lib/statements.ts"]) {
    const source = readFileSync(file, "utf8");
    expect(source, file).not.toMatch(/marginFor|marginKeyOf|billCreditsWith\(/);
  }
  const requests = readFileSync("lib/generationRequests.ts", "utf8");
  expect(requests).not.toMatch(/marginFor|marginKeyOf/);
  /* billCreditsWith in generationRequests prices a NEW job at its own terms (the quote), never a finished take: the baseline row reads the frozen figure. */
  expect(requests).toMatch(/COALESCE\(e\.credits,0\) AS estimated/);
  expect(readFileSync("lib/creditSql.ts", "utf8")).not.toMatch(/function historicalCreditsExpr/);
});

test("a take that was frozen and is then metered reads its receipt and is not estimated: the flag is only for a take with no receipt", async () => {
  const { runInTenant } = await import("../../lib/tenant");
  const { platformReady, platformDb } = await import("../../lib/platform");
  const { db, ready } = await import("../../lib/db");
  const { syncCreditReceipts } = await import("../../lib/creditReceipts");
  const { getGeneration } = await import("../../lib/jobs");
  await platformReady();
  await runInTenant(workspace("ws_est_flag"), async () => {
    await ready();
    /* The workspace's first reservation: its take is written before its meter row, so the first fill sees both takes with no receipt and freezes them. */
    await db().batch([take("old", 100, 1.0), take("first", 5_000, 1.0)], "write");
    await syncCreditReceipts();
    expect((await db().execute("SELECT gen_id FROM estimated_credits ORDER BY gen_id")).rows.map((r) => r.gen_id)).toEqual(["first", "old"]);
    expect(await getGeneration("first")).toMatchObject({ estimated: true });
    /* The meter row arrives and its receipt syncs: that take now reads its receipt and is not estimated; the other stays so. */
    await platformDb().execute({ sql: "INSERT INTO meter_events(id,workspace_id,kind,engine,model,status,engine_cost_usd,billed_credits,paid_by_platform,created_at,updated_at) VALUES('first','ws_est_flag','video','byteplus','dreamina-seedance-2-5-260628','succeeded',1,43,1,5001,5001)", args: [] });
    await syncCreditReceipts();
    expect(await getGeneration("first")).toMatchObject({ creditsBilled: 43, estimated: false });
    expect(await getGeneration("old")).toMatchObject({ estimated: true });
    expect((await db().execute("SELECT COUNT(*) AS n FROM estimated_credits")).rows[0].n).toBe(2);
  });
});
