import { test, expect } from "@playwright/test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { TenantWorkspace } from "../../lib/tenant";
import { alignLedgerUnit } from "../helpers/ledgerUnit";

/**
 * A take with a cost and no receipt keeps the figure frozen for it (lib/estimatedCredits.ts; owner, 14 Oct 2026: "pre-metering takes marked estimated, no repricing" and "freeze
 * 'estimated' figures in their own table"; 15 Oct: "freeze the figure the first time it's read, then never again; it never reads 0"; docs/plans/step-0-data.md item 4, MIGRATION M2):
 * written the first time anything reads it, at that day's terms, and read by every reader of a take's credits instead of computing it. Nothing is written to the meter, a receipt or a balance.
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

test("frozen the first time it is read, at that day's figure, for every take with a cost and no receipt; a receipt, or no cost, is left alone; read again, never changed", async () => {
  const { runInTenant } = await import("../../lib/tenant");
  const { platformReady, platformDb } = await import("../../lib/platform");
  const { db, ready } = await import("../../lib/db");
  const { syncCreditReceipts } = await import("../../lib/creditReceipts");
  const { freezeEstimatesSql } = await import("../../lib/creditSql");
  await platformReady();
  /* The workspace's first meter event is at 1000; one take has a receipt. */
  await platformDb().batch([
    { sql: "INSERT INTO meter_events(id,workspace_id,kind,engine,model,status,engine_cost_usd,billed_credits,paid_by_platform,created_at,updated_at) VALUES('metered','ws_est','video','byteplus','dreamina-seedance-2-5-260628','succeeded',1.0,13,1,1000,1000)", args: [] },
    { sql: "INSERT INTO meter_events(id,workspace_id,kind,engine,model,status,engine_cost_usd,billed_credits,paid_by_platform,created_at,updated_at) VALUES('other','ws_other','video','byteplus','x','succeeded',1,1,1,1,1)", args: [] },
  ], "write");
  await runInTenant(workspace("ws_est"), async () => {
    await ready();
    await db().batch([take("old_a", 100, 1.0), take("old_b", 200, 0.134, "image", "gemini-3-pro-image"), take("old_zero", 300, 0), take("metered", 1000, 1.0), take("newer", 2000, 1.0)], "write");
    const figure = async (id: string) => Number((await db().execute(`SELECT CAST(${freezeEstimatesSql("g")} AS INTEGER) AS c FROM generations g WHERE g.id='${id}'`)).rows[0].c);
    const [expectedOldA, expectedNewer] = [await figure("old_a"), await figure("newer")];
    expect(expectedOldA).toBeGreaterThan(0);
    await syncCreditReceipts();
    const frozen = Object.fromEntries((await db().execute("SELECT gen_id, credits FROM estimated_credits ORDER BY gen_id")).rows.map((r) => [String(r.gen_id), Number(r.credits)]));
    /* No receipt and a cost: frozen, a take newer than the first meter event too. A receipt, or no cost: not. */
    expect(Object.keys(frozen)).toEqual(["newer", "old_a", "old_b"]);
    expect(frozen.old_a).toBe(expectedOldA);
    expect(frozen.newer).toBe(expectedNewer);
    /* A take made after the first read, with no receipt yet, is frozen by the next read; the ones already frozen are not touched. */
    await db().execute(take("late", 50, 5));
    await db().execute("UPDATE estimated_credits SET credits = credits + 100 WHERE gen_id='old_a'");
    await syncCreditReceipts();
    expect((await db().execute("SELECT COUNT(*) AS n FROM estimated_credits")).rows[0].n).toBe(4);
    const { getGeneration } = await import("../../lib/jobs");
    expect((await getGeneration("old_a"))).toMatchObject({ creditsBilled: expectedOldA + 100, estimated: true });
    expect((await getGeneration("metered"))).toMatchObject({ creditsBilled: 13, estimated: false });
    expect((await getGeneration("newer"))).toMatchObject({ creditsBilled: expectedNewer, estimated: true });
    expect((await getGeneration("late"))).toMatchObject({ estimated: true });
    expect((await getGeneration("late"))?.creditsBilled ?? 0).toBeGreaterThan(0);
    expect((await getGeneration("old_zero"))).toMatchObject({ creditsBilled: 0, estimated: false });
    /* The meter, the receipts and every balance are untouched. */
    expect(Number((await platformDb().execute("SELECT COUNT(*) AS n FROM meter_events WHERE workspace_id='ws_est'")).rows[0].n)).toBe(1);
    expect((await db().execute("SELECT event_id FROM credit_receipts")).rows.map((r) => r.event_id)).toEqual(["metered"]);
  });
});

test("a workspace with no meter event at all freezes every costed take it has", async () => {
  const { runInTenant } = await import("../../lib/tenant");
  const { db, ready } = await import("../../lib/db");
  const { syncCreditReceipts } = await import("../../lib/creditReceipts");
  await runInTenant(workspace("ws_est_empty"), async () => {
    await ready();
    await db().batch([take("a", 100, 1), take("b", 5_000_000_000_000, 1)], "write");
    await syncCreditReceipts();
    expect((await db().execute("SELECT gen_id FROM estimated_credits ORDER BY gen_id")).rows.map((r) => r.gen_id)).toEqual(["a", "b"]);
  });
});

test("a costed take with no receipt and no frozen row is frozen by the first read of any reader and counts that figure; a later change to CREDIT_MARGINS does not change it; two first reads freeze once; no cost reads 0", async () => {
  const { runInTenant } = await import("../../lib/tenant");
  const { db, ready } = await import("../../lib/db");
  const { spentBy } = await import("../../lib/caps");
  const { billedCreditsExpr } = await import("../../lib/creditSql");
  const { syncCreditReceipts } = await import("../../lib/creditReceipts");
  const before = process.env.CREDIT_MARGINS;
  try {
    await runInTenant(workspace("ws_est_first"), async () => {
      await ready();
      await db().batch([
        { sql: "INSERT OR IGNORE INTO projects(id,name,created_at) VALUES('pf','Board',0)", args: [] },
        { sql: "INSERT INTO generations(id,kind,model,prompt,params,status,created_at,updated_at,cost_usd,project_id) VALUES('costed','video','dreamina-seedance-2-5-260628','','{}','succeeded',5,5,1.0,'pf')", args: [] },
        { sql: "INSERT INTO generations(id,kind,model,prompt,params,status,created_at,updated_at,cost_usd,project_id) VALUES('free','video','dreamina-seedance-2-5-260628','','{}','succeeded',6,6,0,'pf')", args: [] },
      ], "write");
      expect((await db().execute("SELECT COUNT(*) AS n FROM estimated_credits")).rows[0].n, "nothing is frozen until something reads").toBe(0);
      /* The cap reader is the first reader: it freezes the take, and counts the frozen figure (never 0). */
      const first = (await spentBy("project_id", ["pf"])).get("pf")!.credits;
      expect(first).toBeGreaterThan(0);
      const row = (await db().execute("SELECT credits FROM estimated_credits WHERE gen_id='costed'")).rows;
      expect(row.length).toBe(1);
      expect(Number(row[0].credits)).toBe(first);
      expect((await db().execute("SELECT 1 FROM estimated_credits WHERE gen_id='free'")).rows.length, "no cost: nothing to freeze").toBe(0);
      expect(Number((await db().execute(`SELECT ${billedCreditsExpr("g")} AS c FROM generations g WHERE g.id='free'`)).rows[0].c)).toBe(0);
      /* The margin table changes: the frozen figure does not, for the cap reader or the SQL every other reader uses. */
      process.env.CREDIT_MARGINS = JSON.stringify({ "*": 9, video: 9 });
      expect((await spentBy("project_id", ["pf"])).get("pf")!.credits).toBe(first);
      await syncCreditReceipts();
      expect(Number((await db().execute(`SELECT ${billedCreditsExpr("g")} AS c FROM generations g WHERE g.id='costed'`)).rows[0].c)).toBe(first);
      expect(Number((await db().execute("SELECT credits FROM estimated_credits WHERE gen_id='costed'")).rows[0].credits)).toBe(first);
    });
    /* Two first reads together freeze once, at one figure. */
    await runInTenant(workspace("ws_est_race"), async () => {
      await ready();
      await db().execute({ sql: "INSERT INTO generations(id,kind,model,prompt,params,status,created_at,updated_at,cost_usd) VALUES('race','video','dreamina-seedance-2-5-260628','','{}','succeeded',5,5,1.0)", args: [] });
      await Promise.all([syncCreditReceipts(), syncCreditReceipts(), syncCreditReceipts()]);
      const rows = (await db().execute("SELECT credits FROM estimated_credits WHERE gen_id='race'")).rows;
      expect(rows.length).toBe(1);
      expect(Number(rows[0].credits)).toBeGreaterThan(0);
    });
  } finally { if (before === undefined) delete process.env.CREDIT_MARGINS; else process.env.CREDIT_MARGINS = before; }
});

test("if the platform cannot answer, the take with a cost is still frozen and counted by the cap, and the failure still reaches the caller", async () => {
  const { runInTenant } = await import("../../lib/tenant");
  const { db, ready } = await import("../../lib/db");
  const { spentBy } = await import("../../lib/caps");
  const receipts = await import("../../lib/creditReceipts");
  await runInTenant(workspace("ws_est_down"), async () => {
    await ready();
    await db().batch([
      { sql: "INSERT OR IGNORE INTO projects(id,name,created_at) VALUES('pd','Board',0)", args: [] },
      { sql: "INSERT INTO generations(id,kind,model,prompt,params,status,created_at,updated_at,cost_usd,project_id) VALUES('down','video','dreamina-seedance-2-5-260628','','{}','succeeded',5,5,1.0,'pd')", args: [] },
    ], "write");
    /* The receipt copy fails (as it does when the platform cannot answer): here its cursor table, in this test's own database, is out of reach for a moment. */
    await db().execute("ALTER TABLE credit_receipt_cursor RENAME TO credit_receipt_cursor_off");
    try {
      await expect(receipts.syncCreditReceipts()).rejects.toThrow();
      expect((await spentBy("project_id", ["pd"])).get("pd")!.credits, "counted at its estimate, never 0").toBeGreaterThan(0);
      expect((await db().execute("SELECT COUNT(*) AS n FROM estimated_credits WHERE gen_id='down'")).rows[0].n).toBe(1);
    } finally { await db().execute("ALTER TABLE credit_receipt_cursor_off RENAME TO credit_receipt_cursor"); }
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
  expect(requests).toMatch(/billedCreditsExpr\("g"\)\} AS estimated/);
  /* None of the three readers takes a take's credits from the frozen table alone: each reads receipt, then frozen, then 0 (billedCreditsExpr), so a metered take reads its receipt when the platform's meter rows cannot be read. */
  for (const file of ["lib/caps.ts", "lib/statements.ts", "lib/generationRequests.ts"]) {
    const source = readFileSync(file, "utf8");
    expect(source, file).toMatch(/billedCreditsExpr\("g"\)/);
    expect(source, file).not.toMatch(/LEFT JOIN estimated_credits|\be\.credits\b/);
  }
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
    /* The workspace's first reservation: its take is written before its meter row, so the first read sees both takes with no receipt and freezes them. */
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

/* ── A metered take reads its receipt even when the platform's meter rows are not there to override (owner-approved fix, Opus review of 384e2f70) ── */
const SEEDANCE = "dreamina-seedance-2-5-260628";
const receipt = (id: string, credits: number) => ({ sql: "INSERT OR REPLACE INTO credit_receipts(event_id,credits,revision) VALUES(?,?,?)", args: [id, credits, 1_000_000] });

test("with no meter row to override, a metered take reads its receipt in the cap reader, the gate's baseline and the statement; never 0", async () => {
  const { runInTenant } = await import("../../lib/tenant");
  const { platformReady, platformDb } = await import("../../lib/platform");
  const { db, ready } = await import("../../lib/db");
  const { spentBy } = await import("../../lib/caps");
  const { statementFor } = await import("../../lib/statements");
  const { reserveGenerationSpend, SpendReservationError } = await import("../../lib/generationRequests");
  await platformReady();
  await alignLedgerUnit();
  await platformDb().execute({ sql: "INSERT INTO credit_grants(id,workspace_id,credits,kind,created_at) VALUES('grant_rcpt','ws_est_rcpt',500,'manual',0)", args: [] });
  await runInTenant(workspace("ws_est_rcpt"), async () => {
    await ready();
    const at = Date.now() - 2 * 3_600_000;
    await db().batch([
      { sql: "INSERT OR IGNORE INTO projects(id,name,created_at,cap_credits) VALUES('pr','Board',0,30)", args: [] },
      { sql: "INSERT INTO generations(id,kind,model,prompt,params,status,created_at,updated_at,cost_usd,project_id) VALUES('metered','video',?,'','{}','succeeded',?,?,1.0,'pr')", args: [SEEDANCE, at, at] },
      receipt("metered", 25),
    ], "write");
    /* The take has a receipt here and no meter row on the platform, and no frozen row (a receipt is never frozen over). */
    expect((await spentBy("project_id", ["pr"])).get("pr")!.credits, "the cap reader").toBe(25);
    expect((await db().execute("SELECT COUNT(*) AS n FROM estimated_credits WHERE gen_id='metered'")).rows[0].n).toBe(0);
    const gate = await reserveGenerationSpend({ id: "next", kind: "video", engine: "byteplus", model: SEEDANCE, status: "running", engineCostUsd: 0.5, projectId: "pr", createdBy: "owner" })
      .then(() => null, (error: unknown) => error);
    expect(gate, "the gate counts the 25 cr already spent against the 30 cr cap").toBeInstanceOf(SpendReservationError);
    expect((gate as Error).message).toContain("25 cr spent");
    const statement = await statementFor(new Date(at).toISOString().slice(0, 7), null);
    const lines = statement!.projects.flatMap((p) => [...p.shots.flatMap((s) => s.lines), ...p.loose]);
    expect(lines.find((l) => l.id === "metered")?.credits, "the statement").toBe(25);
  });
});

test("a refine-only figure frozen early is shadowed by the take's receipt in all three readers", async () => {
  const { runInTenant } = await import("../../lib/tenant");
  const { platformReady, platformDb } = await import("../../lib/platform");
  const { db, ready } = await import("../../lib/db");
  const { spentBy } = await import("../../lib/caps");
  const { statementFor } = await import("../../lib/statements");
  const { reserveGenerationSpend, SpendReservationError } = await import("../../lib/generationRequests");
  await platformReady();
  await alignLedgerUnit();
  await platformDb().execute({ sql: "INSERT INTO credit_grants(id,workspace_id,credits,kind,created_at) VALUES('grant_shadow','ws_est_shadow',500,'manual',0)", args: [] });
  await runInTenant(workspace("ws_est_shadow"), async () => {
    await ready();
    const { syncCreditReceipts } = await import("../../lib/creditReceipts");
    const at = Date.now() - 2 * 3_600_000;
    await db().batch([
      { sql: "INSERT OR IGNORE INTO projects(id,name,created_at,cap_credits) VALUES('ps','Board',0,30)", args: [] },
      /* Held, with only the prompt writer's cost so far. */
      { sql: "INSERT INTO generations(id,kind,model,prompt,params,status,created_at,updated_at,refine_cost_usd,project_id) VALUES('shadow','video',?,'','{}','held',?,?,0.05,'ps')", args: [SEEDANCE, at, at] },
    ], "write");
    await syncCreditReceipts();
    const early = Number((await db().execute("SELECT credits FROM estimated_credits WHERE gen_id='shadow'")).rows[0].credits);
    expect(early, "frozen early, at the partial figure").toBeLessThan(25);
    expect((await spentBy("project_id", ["ps"])).get("ps")!.credits).toBe(early);
    /* The receipt arrives: it shadows the frozen row everywhere. */
    await db().execute(receipt("shadow", 25));
    expect((await spentBy("project_id", ["ps"])).get("ps")!.credits, "the cap reader").toBe(25);
    const gate = await reserveGenerationSpend({ id: "next2", kind: "video", engine: "byteplus", model: SEEDANCE, status: "running", engineCostUsd: 0.5, projectId: "ps", createdBy: "owner" })
      .then(() => null, (error: unknown) => error);
    expect((gate as Error).message, "the gate").toContain("25 cr spent");
    expect(gate).toBeInstanceOf(SpendReservationError);
    const lines = (await statementFor(new Date(at).toISOString().slice(0, 7), null))!.projects.flatMap((p) => [...p.shots.flatMap((s) => s.lines), ...p.loose]);
    expect(lines.find((l) => l.id === "shadow")?.credits, "the statement").toBe(25);
    expect((await db().execute("SELECT credits FROM estimated_credits WHERE gen_id='shadow'")).rows[0].credits, "the frozen row itself is never changed").toBe(early);
  });
});

test("a take held in one month and released in the next is on exactly one statement, at its billed figure", async () => {
  const { runInTenant } = await import("../../lib/tenant");
  const { platformReady, platformDb } = await import("../../lib/platform");
  const { db, ready } = await import("../../lib/db");
  const { statementFor } = await import("../../lib/statements");
  await platformReady();
  const made = Date.UTC(2026, 8, 30, 23, 59), reserved = Date.UTC(2026, 9, 1, 0, 5);
  /* The meter row is stamped when the job is reserved (after midnight), the take when it was made. */
  await platformDb().execute({ sql: "INSERT INTO meter_events(id,workspace_id,kind,engine,model,status,engine_cost_usd,billed_credits,paid_by_platform,created_at,updated_at) VALUES('edge','ws_est_edge','video','byteplus',?,'succeeded',1.0,25,1,?,?)", args: [SEEDANCE, reserved, reserved] });
  await runInTenant(workspace("ws_est_edge"), async () => {
    await ready();
    await db().batch([
      { sql: "INSERT INTO generations(id,kind,model,prompt,params,status,created_at,updated_at,cost_usd) VALUES('edge','video',?,'','{}','succeeded',?,?,1.0)", args: [SEEDANCE, made, made] },
      receipt("edge", 25),
    ], "write");
    const linesOf = async (month: string) => (await statementFor(month, null))!.projects.flatMap((p) => [...p.shots.flatMap((s) => s.lines), ...p.loose]).filter((l) => l.id === "edge");
    const september = await linesOf("2026-09"), october = await linesOf("2026-10");
    expect(september.map((l) => l.credits), "September lists it at its billed figure").toEqual([25]);
    expect(october, "October does not list it again").toEqual([]);
  });
});
