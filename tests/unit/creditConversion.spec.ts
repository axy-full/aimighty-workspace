import { test, expect } from "@playwright/test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

/**
 * Back to a US$0.10 credit (lib/creditConversion.ts, lib/ledgerUnit.ts).
 *
 * A record written partly at US$0.10 and partly at US$0.80 — as particl.si's
 * is since its build of 3 October — restated in US$0.10 credits, per row or
 * uniformly; paid work paused between the price change and the conversion;
 * dry runs that write nothing; idempotence; an exact reversal.
 */
const dir = mkdtempSync(path.join(tmpdir(), "particl-credit-conversion-"));
process.env.PLATFORM_DATABASE_URL = `file:${path.join(dir, "platform.db")}`;
process.env.TURSO_DATABASE_URL = `file:${path.join(dir, "legacy.db")}`;
process.env.KEYRING_SECRET ??= "unit-test-keyring-secret-unit-test-keyring";
process.env.ENGINE_MOCK = "1";
const previousRate = process.env.CREDIT_USD;
/* Unit files share one platform database per worker: leave the ledger's unit where the next file expects it. */
async function setUnit(usd: number) {
  const { billingTransaction } = await import("../../lib/billingLedger");
  const { setLedgerUnitTx } = await import("../../lib/ledgerUnit");
  await billingTransaction((tx) => setLedgerUnitTx(tx, usd, "test", Date.now()));
}
test.afterAll(async () => {
  if (previousRate === undefined) delete process.env.CREDIT_USD; else process.env.CREDIT_USD = previousRate;
  const { creditUsd } = await import("../../lib/creditTerms");
  await setUnit(creditUsd());
});
test.describe.configure({ mode: "serial" });

const DAY = 86_400_000;
const CUTOVER = Date.UTC(2026, 9, 3, 14, 39);
const BEFORE = CUTOVER - 5 * DAY;
const AFTER = CUTOVER + DAY;
const NOW = CUTOVER + 2 * DAY;
/** When an instance first ran at US$0.10: the end of the old price's window. */
const END = NOW - 3_600_000;

const wsRow = (id: string) => ({ id, dbUrl: `file:${path.join(dir, `${id}.db`)}` });

async function platform() {
  const { platformDb, platformReady } = await import("../../lib/platform");
  const { billingReady } = await import("../../lib/billingLedger");
  await platformReady();
  await billingReady();
  return platformDb();
}

async function addWorkspace(id: string) {
  const p = await platform();
  await p.execute({
    sql: `INSERT OR IGNORE INTO workspaces(id,slug,name,db_url,owner_id,uses_platform_keys,created_at,updated_at) VALUES(?,?,?,?,'owner',1,?,?)`,
    args: [id, id, id, wsRow(id).dbUrl, BEFORE, BEFORE],
  });
}

async function grant(ws: string, id: string, credits: number, kind: string, at: number) {
  await (await platform()).execute({ sql: `INSERT INTO credit_grants(id,workspace_id,credits,kind,created_at) VALUES(?,?,?,?,?)`, args: [id, ws, credits, kind, at] });
}

/** A job as the meter writes one: its credits in the unit it was admitted at, and that unit. */
async function job(ws: string, id: string, credits: number, unit: number | null, at: number, status = "succeeded", allowDebt = true) {
  const p = await platform();
  await p.execute({
    sql: `INSERT INTO meter_events(id,workspace_id,kind,engine,model,status,engine_cost_usd,billed_credits,paid_by_platform,created_at,updated_at,credit_usd,credit_margin)
      VALUES(?,?,'video','byteplus','fixture',?,1,?,1,?,?,?,1)`,
    args: [id, ws, status, credits, at, at, unit],
  });
  const { billingTransaction, syncBillingLedger } = await import("../../lib/billingLedger");
  await billingTransaction(async (tx) => { await syncBillingLedger(tx, ws, at); }, at);
  void allowDebt;
}

/** Every credit-bearing row of a workspace, to compare a state before and after. */
async function dump(ws: string) {
  const p = await platform();
  const q = async (sql: string) => (await p.execute({ sql, args: [ws] })).rows.map((r) => ({ ...r }));
  return {
    grants: await q(`SELECT id,credits FROM credit_grants WHERE workspace_id=? ORDER BY id`),
    lots: await q(`SELECT id,kind,credits,drawn,expires_at FROM billing_lots WHERE workspace_id=? ORDER BY id`),
    debits: await q(`SELECT event_id,credits FROM billing_debits WHERE workspace_id=? ORDER BY event_id`),
    allocations: await q(`SELECT event_id,lot_id,credits FROM billing_allocations WHERE workspace_id=? ORDER BY event_id,lot_id`),
    meter: await q(`SELECT id,billed_credits,credit_usd FROM meter_events WHERE workspace_id=? ORDER BY id`),
    topups: await q(`SELECT id,credits,bonus_credits,usd FROM topup_requests WHERE workspace_id=? ORDER BY id`),
  };
}

async function balance(ws: string, at = NOW) {
  const { billingStateFor } = await import("../../lib/billingLedger");
  return (await billingStateFor(ws, at)).credits;
}

const ALL = ["ws_plain", "ws_pack", "ws_plan", "ws_debt", "ws_running", "ws_held"];

test.beforeAll(async () => {
  process.env.CREDIT_USD = "0.80"; // particl.si today: a deployment at this price, its ledger in it.
  for (const id of ALL) await addWorkspace(id);
  await setUnit(0.8);
  await (await platform()).execute({ sql: `INSERT OR IGNORE INTO accounts(id,email,name,password_hash,created_at) VALUES('acct_owner','owner@example.test','Owner','!',?)`, args: [BEFORE] });
  const p = await platform();
  // A plain balance: a welcome grant at US$0.10 before the cutover, an admin grant at US$0.80 after it.
  await grant("ws_plain", "plain_welcome", 250, "welcome", BEFORE);
  await grant("ws_plain", "plain_manual", 100, "manual", AFTER);
  await job("ws_plain", "plain_old_job", 20, 0.10, BEFORE + DAY);
  await job("ws_plain", "plain_new_job", 3, 0.80, AFTER + 1000);
  // A pack bought at US$0.80 (Starter: 500 cr for $400), one at US$0.10 ($50), and one still open at US$0.80.
  for (const [id, credits, usd, at, status] of [["req_old", 500, 50, BEFORE, "approved"], ["req_new", 500, 400, AFTER, "approved"], ["req_open", 500, 400, AFTER, "requested"]] as const)
    await p.execute({ sql: `INSERT INTO topup_requests(id,workspace_id,pack_id,label,credits,bonus_credits,usd,status,created_at,requested_by) VALUES(?,?,'starter','Starter',?,0,?,?,?,'acct_owner')`,
      args: [id, "ws_pack", credits, usd, status, at] });
  // Approved after the cutover, though asked before it: the grant follows its request, not its time.
  await grant("ws_pack", "topup:req_old:purchase", 500, "purchase", AFTER);
  await grant("ws_pack", "topup:req_new:purchase", 500, "purchase", AFTER);
  // A plan inclusion with an expiry, paid after the cutover, beside a purchased lot.
  const { applyPaidSubscriptionPeriod, addBillingMonths } = await import("../../lib/billingLedger");
  await applyPaidSubscriptionPeriod({ workspaceId: "ws_plan", provider: "test", subscriptionId: "sub_plan", invoiceId: "inv_plan", planId: "studio", interval: "month",
    includedCredits: 400, periodStart: AFTER, periodEnd: addBillingMonths(AFTER, 1), paidUsd: 49 }, AFTER);
  await grant("ws_plan", "plan_pack", 50, "purchase", AFTER);
  await job("ws_plan", "plan_job", 30, 0.80, AFTER + 2000);
  // A debt: 10 granted, 30 spent, all at US$0.80.
  await grant("ws_debt", "debt_grant", 10, "manual", AFTER);
  await job("ws_debt", "debt_job", 30, 0.80, AFTER + 3000);
  // A job still running at US$0.80: its reservation.
  await grant("ws_running", "run_grant", 100, "manual", AFTER);
  await job("ws_running", "run_job", 5, 0.80, AFTER + 4000, "running");
  await grant("ws_held", "held_grant", 2, "manual", AFTER);
});

test("an exact integer factor or nothing", async () => {
  const { unitFactor } = await import("../../lib/creditConversion");
  expect(unitFactor(0.80, 0.10)).toBe(8);
  expect(unitFactor(0.30, 0.10)).toBe(3);
  expect(unitFactor(0.15, 0.10)).toBeNull();
  expect(unitFactor(0.10, 0.80)).toBeNull();
  expect(unitFactor(0.10, 0.10)).toBeNull();
});

test("the ledger is seeded at the deployment's price; changing CREDIT_USD pauses new paid jobs only", async () => {
  const { ledgerOpenTx, ledgerUnitTx, LEDGER_UNIT_PAUSED } = await import("../../lib/ledgerUnit");
  const p = await platform();
  expect(await ledgerUnitTx(p)).toBe(0.8);
  expect(await ledgerOpenTx(p)).toBe(true);
  process.env.CREDIT_USD = "0.10";
  expect(await ledgerOpenTx(p)).toBe(false);
  const { runInTenant } = await import("../../lib/tenant");
  const { getWorkspace } = await import("../../lib/platform");
  const { reserveGenerationSpend, SpendReservationError } = await import("../../lib/generationRequests");
  const ws = (await getWorkspace("ws_plain"))!;
  const refused = await runInTenant(ws, () => reserveGenerationSpend({ id: "paused_job", kind: "video", engine: "byteplus", model: "fixture", status: "running", engineCostUsd: 0.4 }))
    .then(() => null, (e) => e);
  expect(refused).toBeInstanceOf(SpendReservationError);
  expect(refused.status).toBe(503);
  expect(refused.message).toBe(LEDGER_UNIT_PAUSED);
  expect(LEDGER_UNIT_PAUSED).toBe("Paid work is paused for a few minutes while we update pricing. Nothing has been charged.");
  expect((await p.execute(`SELECT 1 FROM meter_events WHERE id='paused_job'`)).rows).toHaveLength(0);
  // A direct paid start is refused the same way, and a job already reserved still starts.
  const { meter, assertMeterFunding } = await import("../../lib/meter");
  const direct = await runInTenant(ws, () => meter({ id: "paused_direct", kind: "image", engine: "fal", model: "fixture", status: "running", engineCostUsd: 0.1 })).then(() => null, (e) => e);
  expect(direct?.message).toBe(LEDGER_UNIT_PAUSED);
  const running = (await getWorkspace("ws_running"))!;
  await runInTenant(running, () => assertMeterFunding("run_job", "byteplus"));
});

test("a dry run shows both modes and writes nothing", async () => {
  const { convertAllCredits } = await import("../../lib/creditConversion");
  const before = await Promise.all(ALL.map(dump));
  const uniform = await convertAllCredits({ fromUsd: 0.80, toUsd: 0.10, mode: "uniform", endAt: END, dryRun: true, at: NOW, universe: ALL });
  const perRow = await convertAllCredits({ fromUsd: 0.80, toUsd: 0.10, mode: "per-row", cutoverAt: CUTOVER, endAt: END, dryRun: true, at: NOW, universe: ALL });
  expect(await Promise.all(ALL.map(dump))).toEqual(before);
  const line = (run: typeof uniform, id: string) => run.results.find((r) => r.workspaceId === id)!;
  // Uniform: what every balance reads today, in dollars, kept exactly.
  for (const r of uniform.results.filter((x) => x.status === "planned")) {
    expect(r.after!.balanceUsd).toBeCloseTo(r.before!.balanceUsd, 9);
    expect(r.after!.balance).toBeCloseTo(r.before!.balance * 8, 9);
  }
  // Per row: the welcome given at $0.10 stays 250 credits; what came at $0.80 is ×8.
  // 250 welcome - 20 (old job) + 100×8 (manual) - 3×8 (new job) = 1006.
  const plain = line(perRow, "ws_plain");
  expect(plain.after!.balance).toBe(1006);
  expect(line(uniform, "ws_plain").after!.balance).toBe((250 - 20 + 100 - 3) * 8);
  // The $0.80 job took its 3 credits from the $0.10 welcome: 21 more of it, $2.10, listed apart for the owner.
  expect(plain.status).toBe("needs-decision");
  expect(perRow.needsDecision.map((d) => [d.workspaceId, d.shortfall, d.shortfallUsd, d.balanceWithGoodwill])).toEqual([["ws_plain", 21, 2.1, 1027]]);
  expect(perRow.needsDecision[0].marks?.test).toBe(false);
  // Packs: the $50 pack stays 500, the $400 pack becomes 4,000; the request still open at $0.80 is declined, not converted.
  expect(line(perRow, "ws_pack").after!.purchased).toBe(4500);
  expect(line(perRow, "ws_pack").before!.pendingPacks).toBe(500);
  expect(line(perRow, "ws_pack").after!.pendingPacks).toBe(0);
  expect(perRow.declinedTopups).toMatchObject([{ workspaceId: "ws_pack", workspaceName: "ws_pack", id: "req_open", pack: "Starter", credits: 500, usd: 400,
    requesterName: "Owner", requesterEmail: "owner@example.test", note: "Price changed; please ask again at US$0.10." }]);
  expect(uniform.results.find((r) => r.workspaceId === "ws_legacy")?.status ?? "house").toBe("house");
  expect(uniform.ledgerUnitAfter).toBe(0.8);
  // A debt from before the conversion is listed apart, no decision: the same dollars owed, in more credits.
  expect(perRow.debts.map((d) => [d.workspaceId, d.balanceBefore, d.balanceAfter, d.usdBefore, d.usdAfter])).toEqual([["ws_debt", -20, -160, -16, -16]]);
});

test("a real run converts per row, keeps every lot's kind and expiry, and resumes paid work", async () => {
  const { convertAllCredits } = await import("../../lib/creditConversion");
  const { ledgerOpenTx } = await import("../../lib/ledgerUnit");
  const plan = await dump("ws_plan");
  // Without a decision for every balance it lowers, nothing is written anywhere, and paid work stays paused.
  await expect(convertAllCredits({ fromUsd: 0.80, toUsd: 0.10, mode: "per-row", cutoverAt: CUTOVER, endAt: END, dryRun: false, at: NOW, by: "owner", universe: ALL }))
    .rejects.toThrow(/needsDecision first: ws_plain/);
  expect(await ledgerOpenTx(await platform())).toBe(false);
  expect((await dump("ws_debt")).grants).toEqual([{ id: "debt_grant", credits: 10 }]);
  expect((await dump("ws_plain")).grants).toEqual([{ id: "plain_manual", credits: 100 }, { id: "plain_welcome", credits: 250 }]);
  const run = await convertAllCredits({ fromUsd: 0.80, toUsd: 0.10, mode: "per-row", cutoverAt: CUTOVER, endAt: END, dryRun: false, at: NOW, by: "owner", universe: ALL, decisions: { ws_plain: "goodwill" } });
  expect(run.waiting).toEqual([]);
  // Goodwill: the shortfall written off as a recorded grant; the balance ends where it was heading.
  expect((await balance("ws_plain")).balance).toBe(1027);
  expect((await platform()).execute(`SELECT status,decision_note FROM topup_requests WHERE id='req_open'`).then((r) => ({ ...r.rows[0] })))
    .resolves.toEqual({ status: "declined", decision_note: "Price changed; please ask again at US$0.10." });
  expect(run.ledgerUnitAfter).toBe(0.1);
  expect(await ledgerOpenTx(await platform())).toBe(true);
  // Included and purchased stay apart and keep their expiry; 30 cr of spend came out of the included lot first.
  const after = await dump("ws_plan");
  for (const lot of plan.lots) {
    const now = after.lots.find((l) => l.id === lot.id)!;
    expect(now.kind).toBe(lot.kind);
    expect(now.expires_at).toBe(lot.expires_at);
    expect(Number(now.credits)).toBe(Number(lot.credits) * 8);
  }
  const state = await balance("ws_plan");
  expect(state.includedBalance).toBe((400 - 30) * 8);
  expect(state.purchasedBalance).toBe(400);
  // Debt is eight times as many credits, the same dollars.
  expect((await balance("ws_debt")).balance).toBe(-160);
  // The running job's reservation is ×8; it keeps the price it was approved at.
  const reserved = (await dump("ws_running")).meter[0];
  expect(Number(reserved.billed_credits)).toBe(40);
  expect(Number(reserved.credit_usd)).toBe(0.8);
  const { runInTenant } = await import("../../lib/tenant");
  const { getWorkspace } = await import("../../lib/platform");
  const { meter } = await import("../../lib/meter");
  // It settles in the unit it was approved in, counted once in the new one: 3 credits at $0.80 ($2.40)
  // are booked as 24 credits at $0.10. Settling twice changes nothing.
  for (let i = 0; i < 2; i++)
    await runInTenant((await getWorkspace("ws_running"))!, () => meter({ id: "run_job", kind: "video", engine: "byteplus", model: "fixture", status: "succeeded", engineCostUsd: 2 }));
  expect((await balance("ws_running")).balance).toBe(800 - 24);
  // Twice is once.
  const again = await convertAllCredits({ fromUsd: 0.80, toUsd: 0.10, mode: "per-row", cutoverAt: CUTOVER, endAt: END, dryRun: false, at: NOW, universe: ALL, decisions: { ws_plain: "goodwill" } });
  expect(again.results.filter((r) => r.status === "converted")).toEqual([]);
  expect((await balance("ws_debt")).balance).toBe(-160);
});

test("a reversal is its own row and gives back the exact numbers; converting again works", async () => {
  const { reverseAllCredits, convertAllCredits, listCreditConversions } = await import("../../lib/creditConversion");
  const { ledgerUnitTx } = await import("../../lib/ledgerUnit");
  const plain = await balance("ws_plain");
  const reversed = await reverseAllCredits({ dryRun: false, at: NOW + 1000, by: "owner", universe: ALL });
  expect(reversed.results.filter((r) => r.status === "reversed").length).toBe(ALL.length);
  expect(await ledgerUnitTx(await platform())).toBe(0.8);
  const back = await dump("ws_plain");
  // The goodwill grant is taken back by the reversal, on the record.
  expect(back.grants).toEqual([{ id: "plain_manual", credits: 100 }, { id: "plain_welcome", credits: 250 }, { id: "unit:ws_plain:1:goodwill", credits: 0 }]);
  expect(back.meter.map((m) => [m.id, Number(m.billed_credits), Number(m.credit_usd)])).toEqual([["plain_new_job", 3, 0.8], ["plain_old_job", 20, 0.1]]);
  const record = await listCreditConversions("ws_plain");
  expect(record.map((r) => r.action)).toEqual(["reverse", "convert"]);
  expect(record[0].reverses).toBe(record[1].id);
  await convertAllCredits({ fromUsd: 0.80, toUsd: 0.10, mode: "per-row", cutoverAt: CUTOVER, endAt: END, dryRun: false, at: NOW + 2000, universe: ALL, decisions: { ws_plain: "goodwill" } });
  expect((await balance("ws_plain")).balance).toBe(plain.balance);
  expect(await ledgerUnitTx(await platform())).toBe(0.1);
});

test("the workspace's own credit figures follow: caps, ceilings and held takes", async () => {
  const { convertTenantFigures } = await import("../../lib/creditConversionTenant");
  const { getWorkspace } = await import("../../lib/platform");
  const { runInTenant } = await import("../../lib/tenant");
  const { db, ready } = await import("../../lib/db");
  await addWorkspace("ws_tenant");
  const ws = (await getWorkspace("ws_tenant"))!;
  await runInTenant(ws, async () => {
    await ready();
    await db().execute({ sql: `INSERT INTO settings(key,value,updated_by,updated_at) VALUES('shotCapCredits','25','owner',?)`, args: [AFTER] });
    await db().execute({ sql: `INSERT INTO users(id,email,name,password_hash,role,disabled,created_at) VALUES('u','u@example.test','U','!','admin',0,?)`, args: [BEFORE] });
    await db().execute({ sql: `INSERT INTO api_tokens(id,token_hash,name,user_id,scope,cap_credits,created_at) VALUES('tok','h','t','u','render',50,?)`, args: [AFTER] });
    await db().execute({ sql: `INSERT INTO api_tokens(id,token_hash,name,user_id,scope,cap_credits,created_at) VALUES('tok_old','h2','t','u','render',50,?)`, args: [BEFORE] });
    await db().execute({ sql: `INSERT INTO generations(id,model,prompt,params,status,created_at,updated_at,kind) VALUES('held1','fixture','',?,'held',?,?,'video')`,
      args: [JSON.stringify({ held: { estUsd: 0.5, needs: 1, at: AFTER, why: "credits" } }), AFTER, AFTER] });
  });
  // Caps are never guessed from a timestamp: the owner chooses; one not named is kept.
  const plan = { factorAt: (ts: number | null) => (ts != null && ts >= CUTOVER ? 8 : 1), factor: 8, conversionId: "unit:test:1", dryRun: false,
    caps: { "settings:shotCapCredits": "x8" as const, "api_tokens:tok": "x8" as const } };
  process.env.CREDIT_USD = "0.10";
  const figures = await convertTenantFigures(ws, plan);
  expect(figures.find((f) => f.what === "settings.shotCapCredits")).toMatchObject({ before: 25, after: 200, cap: { id: "settings:shotCapCredits", choice: "x8" } });
  expect(figures.filter((f) => f.what === "api_tokens.cap_credits").map((f) => [f.id, f.after, f.cap?.choice]).sort()).toEqual([["tok", 400, "x8"], ["tok_old", 50, "keep"]]);
  // Re-priced from its held dollars at $0.10 a credit, exactly as Release will charge it.
  const { heldPriceNow } = await import("../../lib/creditTerms");
  const released = heldPriceNow({ estUsd: 0.5 }, "video", "fixture");
  expect(released).toBeGreaterThan(1);
  expect(figures.find((f) => f.what === "generations.params.held.needs")).toMatchObject({ before: 1, after: released });
  // Run again: nothing more changes.
  expect(await convertTenantFigures(ws, plan)).toEqual([]);
  await runInTenant(ws, async () => {
    expect(String((await db().execute(`SELECT value FROM settings WHERE key='shotCapCredits'`)).rows[0].value)).toBe("200");
  });
  // Reversal divides what was multiplied.
  await convertTenantFigures(ws, { ...plan, conversionId: "unit:test:2", reverses: "unit:test:1" });
  await runInTenant(ws, async () => {
    expect(String((await db().execute(`SELECT value FROM settings WHERE key='shotCapCredits'`)).rows[0].value)).toBe("25");
    expect(Number((await db().execute(`SELECT cap_credits FROM api_tokens WHERE id='tok'`)).rows[0].cap_credits)).toBe(50);
    expect(Number((await db().execute(`SELECT json_extract(params,'$.held.needs') AS n FROM generations WHERE id='held1'`)).rows[0].n)).toBe(1);
  });
});

test("a real run refuses while CREDIT_USD has not moved, a uniform run, and a factor that is not whole", async () => {
  const { convertAllCredits } = await import("../../lib/creditConversion");
  process.env.CREDIT_USD = "0.80";
  await expect(convertAllCredits({ fromUsd: 0.80, toUsd: 0.10, mode: "per-row", cutoverAt: CUTOVER, endAt: END, dryRun: false, universe: ALL })).rejects.toThrow(/CREDIT_USD/);
  await expect(convertAllCredits({ fromUsd: 0.80, toUsd: 0.10, mode: "uniform", dryRun: false, universe: ALL })).rejects.toThrow(/per row/);
  await expect(convertAllCredits({ fromUsd: 0.15, toUsd: 0.10, mode: "uniform", dryRun: true })).rejects.toThrow(/whole number/);
  process.env.CREDIT_USD = "0.10";
  await expect(convertAllCredits({ fromUsd: 0.30, toUsd: 0.10, mode: "per-row", cutoverAt: CUTOVER, endAt: END, dryRun: false, universe: ALL })).rejects.toThrow(/0\.80 → US\$0\.10 only/);
  process.env.CREDIT_USD = "0.10";
});

/* ── Review of #524 (5 October 2026): each defect, asserted fixed ─────────────────────────── */

const REVIEW = ["ws_ra", "ws_rneeds", "ws_rexp", "ws_rrev"];

test.describe("review fixes", () => {
  test.beforeAll(async () => {
    process.env.CREDIT_USD = "0.80";
    for (const id of REVIEW) await addWorkspace(id);
    await setUnit(0.8);
    const sync = async (ws: string, at: number) => {
      const { billingTransaction, syncBillingLedger } = await import("../../lib/billingLedger");
      await billingTransaction(async (tx) => { await syncBillingLedger(tx, ws, at); }, at);
    };
    await grant("ws_ra", "ra_grant", 100, "manual", AFTER); await sync("ws_ra", AFTER);
    await job("ws_ra", "ra_run", 5, 0.8, AFTER + 1000, "running");
    await grant("ws_rneeds", "rn_welcome", 250, "welcome", BEFORE); await sync("ws_rneeds", BEFORE);
    await job("ws_rneeds", "rn_job", 3, 0.8, AFTER + 2000);
    // A $0.10 lot that expired after the cutover, 100 of its 400 drawn by a $0.80 job; 300 lapsed.
    await grant("ws_rexp", "re_lot", 400, "manual", BEFORE); await sync("ws_rexp", BEFORE);
    await (await platform()).execute(`UPDATE billing_lots SET expires_at=${AFTER + DAY / 2} WHERE id='re_lot'`);
    await job("ws_rexp", "re_job", 100, 0.8, AFTER + 3000);
    await grant("ws_rrev", "rr_grant", 100, "manual", AFTER); await sync("ws_rrev", AFTER);
    process.env.CREDIT_USD = "0.10";
  });

  test("restateFactor restates up only", async () => {
    const { restateFactor } = await import("../../lib/ledgerUnit");
    expect(restateFactor(0.8, 0.1)).toBe(8);
    // A job approved at a lower price keeps its own credits (second review, M1).
    expect(restateFactor(0.1, 0.8)).toBe(1);
    expect(restateFactor(0.15, 0.1)).toBe(1);
  });

  test("an expired $0.10 lot's lapsed credits are not revived by goodwill", async () => {
    const { convertAllCredits } = await import("../../lib/creditConversion");
    const run = await convertAllCredits({ fromUsd: 0.8, toUsd: 0.1, mode: "per-row", cutoverAt: CUTOVER, endAt: END, dryRun: true, at: NOW, universe: ["ws_rexp"] });
    const r = run.results[0];
    expect(r.before!.balance).toBe(0);
    expect(r.shortfall).toBe(400);
    expect(r.balanceWithGoodwill).toBe(0); // $0 before, $0 with goodwill
  });

  test("a converted workspace settles a $0.80 job ×8 even while others are not converted yet", async () => {
    const { convertAllCredits } = await import("../../lib/creditConversion");
    const { ledgerUnitTx } = await import("../../lib/ledgerUnit");
    // All-or-nothing on decisions: run 1 without one refuses and writes nothing.
    await expect(convertAllCredits({ fromUsd: 0.8, toUsd: 0.1, mode: "per-row", cutoverAt: CUTOVER, endAt: END, dryRun: false, at: NOW, universe: ["ws_ra", "ws_rneeds"] }))
      .rejects.toThrow(/ws_rneeds/);
    expect(Number((await (await platform()).execute(`SELECT billed_credits FROM meter_events WHERE id='ra_run'`)).rows[0].billed_credits)).toBe(5);
    // One workspace on its own (as after a failed half): it counts in $0.10 while the ledger still says $0.80.
    await convertAllCredits({ fromUsd: 0.8, toUsd: 0.1, mode: "per-row", cutoverAt: CUTOVER, endAt: END, dryRun: false, at: NOW, workspaceId: "ws_ra" });
    expect(await ledgerUnitTx(await platform())).toBe(0.8);
    const { runInTenant } = await import("../../lib/tenant");
    const { getWorkspace } = await import("../../lib/platform");
    const { meter } = await import("../../lib/meter");
    await runInTenant((await getWorkspace("ws_ra"))!, () => meter({ id: "ra_run", kind: "video", engine: "byteplus", model: "fixture", status: "succeeded", engineCostUsd: 2 }));
    expect(Number((await (await platform()).execute(`SELECT billed_credits FROM meter_events WHERE id='ra_run'`)).rows[0].billed_credits)).toBe(24);
    await convertAllCredits({ fromUsd: 0.8, toUsd: 0.1, mode: "per-row", cutoverAt: CUTOVER, endAt: END, dryRun: false, at: NOW + 1000, universe: ["ws_ra", "ws_rneeds"], decisions: { ws_rneeds: "apply" } });
    expect(await ledgerUnitTx(await platform())).toBe(0.1);
    expect((await balance("ws_ra", NOW + 2000)).balance).toBe(800 - 24);
  });

  test("a run after completion converts nothing; a workspace made after the window is new, its welcome kept", async () => {
    const { convertAllCredits } = await import("../../lib/creditConversion");
    await addWorkspace("ws_rlate");
    await (await platform()).execute(`UPDATE workspaces SET created_at=${END + 1000} WHERE id='ws_rlate'`);
    await grant("ws_rlate", "rl_welcome", 250, "welcome", END + 1000);
    const dry = await convertAllCredits({ fromUsd: 0.8, toUsd: 0.1, mode: "per-row", cutoverAt: CUTOVER, endAt: END, dryRun: true, at: NOW + 6000, universe: ["ws_rlate"] });
    expect(dry.results[0].status).toBe("new");
    const again = await convertAllCredits({ fromUsd: 0.8, toUsd: 0.1, mode: "per-row", cutoverAt: CUTOVER, endAt: END, dryRun: false, at: NOW + 6000,
      universe: ["ws_ra", "ws_rneeds", "ws_rlate"], decisions: { ws_rneeds: "apply" } });
    expect(again.results).toEqual([]);
    expect((await balance("ws_rlate", NOW + 7000)).balance).toBe(250);
  });

  test("a grant written after the window closed stays ×1 (a sign-up during the pause)", async () => {
    const { convertAllCredits } = await import("../../lib/creditConversion");
    await setUnit(0.8);
    await addWorkspace("ws_rpause");
    await grant("ws_rpause", "rp_old", 10, "manual", AFTER);
    await grant("ws_rpause", "rp_new", 250, "welcome", END + 10);
    const run = await convertAllCredits({ fromUsd: 0.8, toUsd: 0.1, mode: "per-row", cutoverAt: CUTOVER, endAt: END, dryRun: true, at: NOW, universe: ["ws_rpause"] });
    expect(run.results[0].after!.balance).toBe(80 + 250);
    await setUnit(0.1);
  });

  test("a reversal after new activity is refused and lists it; nothing is divided", async () => {
    const { convertAllCredits, reverseAllCredits } = await import("../../lib/creditConversion");
    const { ledgerUnitTx } = await import("../../lib/ledgerUnit");
    await setUnit(0.8);
    await convertAllCredits({ fromUsd: 0.8, toUsd: 0.1, mode: "per-row", cutoverAt: CUTOVER, endAt: END, dryRun: false, at: NOW, by: "owner", universe: ["ws_rrev"] });
    expect(await ledgerUnitTx(await platform())).toBe(0.1);
    const { runInTenant } = await import("../../lib/tenant");
    const { getWorkspace } = await import("../../lib/platform");
    const { reserveGenerationSpend } = await import("../../lib/generationRequests");
    await runInTenant((await getWorkspace("ws_rrev"))!, () =>
      reserveGenerationSpend({ id: "rr_job", kind: "video", engine: "byteplus", model: "fixture", status: "running", engineCostUsd: 0.4 }));
    const before = (await balance("ws_rrev", NOW + 10)).balance;
    const out = await reverseAllCredits({ dryRun: false, at: NOW + 20_000, by: "owner", universe: ["ws_rrev"] });
    expect(out.results[0].status).toBe("refused");
    expect(out.results[0].activity?.map((a) => a.id)).toContain("rr_job");
    expect(await ledgerUnitTx(await platform())).toBe(0.1);
    expect((await balance("ws_rrev", NOW + 30)).balance).toBe(before);
  });

  test("a run's rig limit follows its approval time, not updated_at", async () => {
    const { convertTenantFigures } = await import("../../lib/creditConversionTenant");
    const { getWorkspace } = await import("../../lib/platform");
    const { runInTenant } = await import("../../lib/tenant");
    const { db, ready } = await import("../../lib/db");
    await addWorkspace("ws_rrig");
    const ws = (await getWorkspace("ws_rrig"))!;
    await runInTenant(ws, async () => {
      await ready();
      const { rigAgentReady } = await import("../../lib/workbench/rig-agent-store");
      await rigAgentReady();
      for (const [id, approved, req] of [["run_old", BEFORE, "q1"], ["run_new", AFTER, "q2"]] as const)
        await db().execute({ sql: `INSERT INTO rig_agent_runs(id,production_id,draft_id,owner,request_id,goal,mode,cap_credits,per_job_cap,model,state,approved_at,created_at,updated_at)
          VALUES(?,?,'d','o',?,'g','ask',60,25,'m','done',?,?,?)`, args: [id, `p_${id}`, req, approved, approved, AFTER + 99] });
    });
    const figures = await convertTenantFigures(ws, { factorAt: (ts) => (ts != null && ts >= CUTOVER && ts < END ? 8 : 1), factor: 8, conversionId: "unit:rig:1", dryRun: true });
    expect(figures.filter((f) => f.what === "rig_agent_runs.cap_credits").map((f) => [f.id, f.after])).toEqual([["run_new", 480]]);
  });

  test("the ledger is seeded from the last job's price, so a first boot at a new price pauses", async () => {
    const { createClient } = await import("@libsql/client");
    const { seedLedgerUnit, ledgerUnitTx, pausedSinceTx, LEDGER_UNIT_SCHEMA } = await import("../../lib/ledgerUnit");
    const c = createClient({ url: `file:${path.join(dir, "seed.db")}` });
    await c.execute(LEDGER_UNIT_SCHEMA);
    await c.execute(`CREATE TABLE meter_events(id TEXT, workspace_id TEXT, credit_usd REAL, created_at INTEGER)`);
    await c.execute(`INSERT INTO meter_events VALUES('a','ws_x',0.1,1),('b','ws_x',0.8,2)`);
    process.env.CREDIT_USD = "0.10";
    await seedLedgerUnit(c, 1234);
    expect(await ledgerUnitTx(c)).toBe(0.8);
    expect(await pausedSinceTx(c)).toBe(1234);
    c.close();
  });

  test("a pre-conversion receipt's dollars are unchanged after conversion, and statements say from when", async () => {
    const { convertAllCredits, creditUnitLine } = await import("../../lib/creditConversion");
    const { getWorkspace } = await import("../../lib/platform");
    const { runInTenant } = await import("../../lib/tenant");
    await setUnit(0.8);
    process.env.CREDIT_USD = "0.80";
    await addWorkspace("ws_rstmt");
    const p = await platform();
    await p.execute({ sql: `INSERT INTO topup_requests(id,workspace_id,pack_id,label,credits,bonus_credits,usd,status,created_at,decided_at) VALUES('rs_req','ws_rstmt','starter','Starter',500,0,400,'approved',?,?)`, args: [AFTER, AFTER] });
    await grant("ws_rstmt", "topup:rs_req:purchase", 500, "purchase", AFTER);
    await job("ws_rstmt", "rs_job", 30, 0.8, AFTER + 5000);
    const { statementFor } = await import("../../lib/statements");
    const month = "2026-10";
    const ws = (await getWorkspace("ws_rstmt"))!;
    const before = (await runInTenant(ws, () => statementFor(month, null)))!;
    expect(before.unitNote).toBeUndefined();
    const usdOf = (s: typeof before, unit: number) => ({ packs: s.packs.usd, jobs: Math.round(s.totals.credits * unit * 100) / 100 });
    const paid = usdOf(before, 0.8);
    process.env.CREDIT_USD = "0.10";
    const at = Date.UTC(2026, 9, 5, 15);
    await convertAllCredits({ fromUsd: 0.8, toUsd: 0.1, mode: "per-row", cutoverAt: CUTOVER, endAt: END, dryRun: false, at, by: "owner", universe: ["ws_rstmt"] });
    const after = (await runInTenant(ws, () => statementFor(month, null)))!;
    expect(usdOf(after, 0.1)).toEqual(paid);
    expect(after.packs.credits).toBe(4000);
    expect(after.unitNote).toBe("Credits shown at US$0.10 each from 5 October 2026.");
    // A month that ended before the old price began was never restated: no line on it.
    expect((await runInTenant(ws, () => statementFor("2026-09", null)))!.unitNote).toBeUndefined();
    expect(creditUnitLine(0.1, Date.UTC(2026, 9, 6))).toBe("Credits shown at US$0.10 each from 6 October 2026.");
  });

  test("a deleted workspace never holds the ledger up; the owner can skip a workspace's own half", async () => {
    const { convertAllCredits } = await import("../../lib/creditConversion");
    const { ledgerUnitTx } = await import("../../lib/ledgerUnit");
    await setUnit(0.8);
    await addWorkspace("ws_rgone");
    await addWorkspace("ws_rbroken");
    await grant("ws_rgone", "rg", 10, "manual", AFTER);
    await grant("ws_rbroken", "rb", 10, "manual", AFTER);
    const p = await platform();
    await p.execute(`UPDATE workspaces SET deleted_at=${AFTER} WHERE id='ws_rgone'`);
    // A database that cannot be opened: its own half fails and is recorded as not done.
    await p.execute(`UPDATE workspaces SET db_url='file:${path.join(dir, "missing-dir", "nope", "x.db")}' WHERE id='ws_rbroken'`);
    await p.execute(`UPDATE workspaces SET db_url='libsql://unreachable.invalid' WHERE id='ws_rbroken'`);
    const run = await convertAllCredits({ fromUsd: 0.8, toUsd: 0.1, mode: "per-row", cutoverAt: CUTOVER, endAt: END, dryRun: false, at: NOW, universe: ["ws_rgone", "ws_rbroken"] });
    expect(run.waiting).toEqual(["ws_rbroken"]);
    expect(await ledgerUnitTx(p)).toBe(0.8);
    const finish = await convertAllCredits({ fromUsd: 0.8, toUsd: 0.1, mode: "per-row", cutoverAt: CUTOVER, endAt: END, dryRun: false, at: NOW + 1, universe: ["ws_rgone", "ws_rbroken"], skipTenant: ["ws_rbroken"] });
    expect(finish.tenantSkipped).toEqual(["ws_rbroken"]);
    expect(await ledgerUnitTx(p)).toBe(0.1);
  });
});

/* ── Second review of #524 (5 October 2026): each defect, asserted fixed ──────────────────── */

test.describe("second review fixes", () => {
  const HOUR = 3_600_000;
  const MIN = 60_000;
  const sync = async (ws: string, at: number) => {
    const { billingTransaction, syncBillingLedger } = await import("../../lib/billingLedger");
    await billingTransaction(async (tx) => { await syncBillingLedger(tx, ws, at); }, at);
  };
  const tenantOf = async (id: string) => {
    const { getWorkspace } = await import("../../lib/platform");
    return (await getWorkspace(id))!;
  };
  /** A workspace at particl.si today: 100 credits granted inside the $0.80 window ($80). */
  const granted = async (id: string) => {
    await addWorkspace(id);
    await grant(id, `${id}_grant`, 100, "manual", AFTER);
    await sync(id, AFTER);
  };
  const run = (body: Record<string, unknown>) => ({ fromUsd: 0.8, toUsd: 0.1, mode: "per-row" as const, cutoverAt: CUTOVER, dryRun: false, by: "owner", ...body });
  const shotCap = async (id: string) => {
    const { runInTenant } = await import("../../lib/tenant");
    const { db } = await import("../../lib/db");
    return runInTenant(await tenantOf(id), async () => String((await db().execute(`SELECT value FROM settings WHERE key='shotCapCredits'`)).rows[0]?.value));
  };
  const saveShotCap = async (id: string, value: string, at: number) => {
    const { runInTenant } = await import("../../lib/tenant");
    const { db, ready } = await import("../../lib/db");
    await runInTenant(await tenantOf(id), async () => {
      await ready();
      await db().execute({ sql: `INSERT INTO settings(key,value,updated_by,updated_at) VALUES('shotCapCredits',?,'admin',?)
        ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`, args: [value, at] });
    });
  };

  test("H1: a workspace reversed on its own pauses alone, admits nothing, and converts again", async () => {
    const { convertAllCredits, reverseAllCredits } = await import("../../lib/creditConversion");
    const { ledgerOpenTx, ledgerUnitTx, LEDGER_UNIT_PAUSED } = await import("../../lib/ledgerUnit");
    const { runInTenant } = await import("../../lib/tenant");
    const { reserveGenerationSpend, SpendReservationError } = await import("../../lib/generationRequests");
    const { meter } = await import("../../lib/meter");
    const { creditsAtTerms, currentBillingTerms } = await import("../../lib/billingTerms");
    process.env.CREDIT_USD = "0.80";
    await setUnit(0.8);
    const both = ["ws_s1a", "ws_s1b"];
    for (const id of both) await granted(id);
    process.env.CREDIT_USD = "0.10";
    const p = await platform();
    expect((await convertAllCredits(run({ endAt: END, at: NOW, universe: both }))).ledgerUnitAfter).toBe(0.1);
    expect((await balance("ws_s1a")).balance).toBe(800);
    // The owner reverses one workspace (to change its decision, say): the platform still counts in $0.10.
    const rev = await reverseAllCredits({ dryRun: false, at: NOW + 1000, by: "owner", workspaceId: "ws_s1a" });
    expect(rev.results.map((r) => r.status)).toEqual(["reversed"]);
    expect(await ledgerUnitTx(p)).toBe(0.1);
    expect((await balance("ws_s1a", NOW + 2000)).balance).toBe(100);
    // That workspace alone is paused: its record counts in $0.80 credits again. The other one is open.
    expect(await ledgerOpenTx(p, "ws_s1a")).toBe(false);
    expect(await ledgerOpenTx(p, "ws_s1b")).toBe(true);
    expect(rev.waiting).toEqual([]);
    const job2 = { kind: "video" as const, engine: "byteplus", model: "fixture", status: "running" as const, engineCostUsd: 2 };
    const refused = await runInTenant(await tenantOf("ws_s1a"), () => reserveGenerationSpend({ id: "s1a_job", ...job2 })).then(() => null, (e) => e);
    expect(refused).toBeInstanceOf(SpendReservationError);
    expect(refused.status).toBe(503);
    expect(refused.message).toBe(LEDGER_UNIT_PAUSED);
    const direct = await runInTenant(await tenantOf("ws_s1a"), () => meter({ id: "s1a_direct", kind: "image", engine: "fal", model: "fixture", status: "running", engineCostUsd: 0.1 }))
      .then(() => null, (e) => e);
    expect(direct?.message).toBe(LEDGER_UNIT_PAUSED);
    expect((await p.execute(`SELECT id FROM meter_events WHERE workspace_id='ws_s1a'`)).rows).toHaveLength(0);
    // Converting it again (the ledger already counts in $0.10) converts that workspace, and it opens.
    const again = await convertAllCredits(run({ endAt: END, at: NOW + 5000, workspaceId: "ws_s1a" }));
    expect(again.results.map((r) => [r.workspaceId, r.status])).toEqual([["ws_s1a", "converted"]]);
    expect((await balance("ws_s1a", NOW + 6000)).balance).toBe(800);
    expect(await ledgerOpenTx(p, "ws_s1a")).toBe(true);
    // A job there now is charged at $0.10, the unit its record counts in.
    await runInTenant(await tenantOf("ws_s1a"), () => reserveGenerationSpend({ id: "s1a_job2", ...job2 }));
    const row = (await p.execute(`SELECT billed_credits,credit_usd FROM meter_events WHERE id='s1a_job2'`)).rows[0];
    expect(Number(row.credit_usd)).toBe(0.1);
    expect(Number(row.billed_credits)).toBe(creditsAtTerms(2, currentBillingTerms("video", "fixture")));
  });

  test("H1: a reversal whose own-database half failed is finished by running it again; converting again finishes it first", async () => {
    const { convertAllCredits, reverseAllCredits } = await import("../../lib/creditConversion");
    const { ledgerUnitTx } = await import("../../lib/ledgerUnit");
    const { runInTenant } = await import("../../lib/tenant");
    const { db } = await import("../../lib/db");
    process.env.CREDIT_USD = "0.80";
    await setUnit(0.8);
    await granted("ws_s2");
    await saveShotCap("ws_s2", "25", AFTER);
    process.env.CREDIT_USD = "0.10";
    const p = await platform();
    const caps = { "ws_s2/settings:shotCapCredits": "x8" as const };
    await convertAllCredits(run({ endAt: END, at: NOW, universe: ["ws_s2"], caps }));
    expect(await shotCap("ws_s2")).toBe("200");
    // Its own database refuses the reversal's write (an outage, simulated with a trigger).
    const outage = async (on: boolean) => runInTenant(await tenantOf("ws_s2"), () =>
      db().execute(on ? `CREATE TRIGGER s2_outage BEFORE UPDATE ON settings BEGIN SELECT RAISE(ABORT,'simulated outage'); END` : `DROP TRIGGER s2_outage`));
    await outage(true);
    const failed = await reverseAllCredits({ dryRun: false, at: NOW + 1000, by: "owner", universe: ["ws_s2"] });
    expect(failed.results[0]).toMatchObject({ status: "reversed", tenantDone: false });
    expect(await shotCap("ws_s2")).toBe("200");
    expect((await balance("ws_s2", NOW + 1500)).balance).toBe(100);
    await outage(false);
    // Running the reversal again finishes its own half; then the ledger is back at $0.80.
    const finished = await reverseAllCredits({ dryRun: false, at: NOW + 2000, by: "owner", universe: ["ws_s2"] });
    expect(finished.results[0]).toMatchObject({ status: "already", tenantDone: true });
    expect(await shotCap("ws_s2")).toBe("25");
    expect(await ledgerUnitTx(p)).toBe(0.8);
    // Converted again, failed again: converting once more finishes the reversal's half before it multiplies.
    await convertAllCredits(run({ endAt: END, at: NOW + 3000, universe: ["ws_s2"], caps }));
    expect(await shotCap("ws_s2")).toBe("200");
    await outage(true);
    expect((await reverseAllCredits({ dryRun: false, at: NOW + 4000, by: "owner", universe: ["ws_s2"] })).results[0]).toMatchObject({ status: "reversed", tenantDone: false });
    await outage(false);
    const again = await convertAllCredits(run({ endAt: END, at: NOW + 6000, universe: ["ws_s2"], caps }));
    expect(again.results.map((r) => [r.status, r.tenantDone])).toEqual([["converted", true]]);
    expect(await shotCap("ws_s2")).toBe("200");
    expect((await balance("ws_s2", NOW + 7000)).balance).toBe(800);
  });

  test("H2: converting again after a reversal keeps the recorded window, whatever a cold start wrote since", async () => {
    const { convertAllCredits, reverseAllCredits } = await import("../../lib/creditConversion");
    const { seedLedgerUnit, pausedSinceTx, ledgerUnitTx } = await import("../../lib/ledgerUnit");
    const T1 = NOW + 10 * DAY; // the first boot at $0.10: the true end of the window, later than every window above
    process.env.CREDIT_USD = "0.80";
    await setUnit(0.8);
    await granted("ws_s3e");
    process.env.CREDIT_USD = "0.10";
    const p = await platform();
    await seedLedgerUnit(p, T1);
    expect(await pausedSinceTx(p)).toBe(T1);
    // A sign-up during the pause: 250 welcome credits at $0.10.
    await addWorkspace("ws_s3new");
    await p.execute(`UPDATE workspaces SET created_at=${T1 + 10 * MIN} WHERE id='ws_s3new'`);
    await grant("ws_s3new", "welcome:ws_s3new", 250, "welcome", T1 + 10 * MIN);
    await sync("ws_s3new", T1 + 10 * MIN);
    const both = ["ws_s3e", "ws_s3new"];
    const first = await convertAllCredits(run({ endAt: T1, at: T1 + 60 * MIN, universe: both }));
    expect(first.results.map((r) => r.status)).toEqual(["converted", "new"]);
    await reverseAllCredits({ dryRun: false, at: T1 + 62 * MIN, by: "owner", universe: both });
    expect(await ledgerUnitTx(p)).toBe(0.8);
    // Any instance cold-starts: the ledger ($0.80) is not CREDIT_USD ($0.10), so it notes a pause from now.
    await seedLedgerUnit(p, T1 + 70 * MIN);
    expect(await pausedSinceTx(p)).toBe(T1 + 70 * MIN);
    // Converted again as the runbook says, with no endAt: the window the first conversion recorded.
    const again = await convertAllCredits(run({ at: T1 + 80 * MIN, universe: both }));
    expect(again.endAt).toBe(T1);
    expect(again.results.map((r) => r.status)).toEqual(["converted", "new"]);
    expect((await balance("ws_s3new", T1 + 81 * MIN)).balance).toBe(250);
    expect((await balance("ws_s3e", T1 + 81 * MIN)).balance).toBe(800);
  });

  test("H2: after a reversal and a return to $0.80 with paid work, the recorded window is refused", async () => {
    const { convertAllCredits, reverseAllCredits } = await import("../../lib/creditConversion");
    const T4 = NOW + 20 * DAY;
    process.env.CREDIT_USD = "0.80";
    await setUnit(0.8);
    await granted("ws_s4");
    process.env.CREDIT_USD = "0.10";
    await convertAllCredits(run({ endAt: T4, at: T4 + HOUR, universe: ["ws_s4"] }));
    await reverseAllCredits({ dryRun: false, at: T4 + 2 * HOUR, by: "owner", universe: ["ws_s4"] });
    // CREDIT_USD set back to 0.80: particl.si runs at $0.80 again, and a paid job is approved at it.
    await job("ws_s4", "s4_job", 3, 0.80, T4 + 3 * HOUR);
    await expect(convertAllCredits(run({ at: T4 + 5 * HOUR, universe: ["ws_s4"] }))).rejects.toThrow(/ran at US\$0\.80 again after the reversal/);
  });

  test("M1: a pre-cutover job settling between the merge and the conversion keeps its credits: 220 stays 220", async () => {
    const { convertAllCredits } = await import("../../lib/creditConversion");
    const { runInTenant } = await import("../../lib/tenant");
    const { meter } = await import("../../lib/meter");
    process.env.CREDIT_USD = "0.80"; // #524 merged while particl.si runs at $0.80
    await setUnit(0.8);
    await addWorkspace("ws_s5");
    await grant("ws_s5", "s5_welcome", 250, "welcome", BEFORE);
    await sync("ws_s5", BEFORE);
    // Reserved at $0.10 before the cutover, 30 credits, still running at the merge (awaiting reconciliation).
    await job("ws_s5", "s5_job", 30, 0.10, BEFORE + 1000, "running");
    expect((await balance("ws_s5")).balance).toBe(220);
    // Reconciled after the merge, before the conversion, at the cost it was reserved for: still 30 credits.
    await runInTenant(await tenantOf("ws_s5"), () => meter({ id: "s5_job", kind: "video", engine: "byteplus", model: "fixture", status: "succeeded", engineCostUsd: 3 }));
    const p = await platform();
    expect(Number((await p.execute(`SELECT billed_credits FROM meter_events WHERE id='s5_job'`)).rows[0].billed_credits)).toBe(30);
    expect((await balance("ws_s5")).balance).toBe(220);
    process.env.CREDIT_USD = "0.10";
    const out = await convertAllCredits(run({ endAt: END, at: NOW, universe: ["ws_s5"] }));
    expect([out.results[0].before!.balance, out.results[0].after!.balance]).toEqual([220, 220]);
    expect((await balance("ws_s5")).balance).toBe(220);
  });

  test("M2: a reversal is refused when the workspace's own database has figures saved since the conversion", async () => {
    const { convertAllCredits, reverseAllCredits } = await import("../../lib/creditConversion");
    const { ledgerUnitTx } = await import("../../lib/ledgerUnit");
    const { runInTenant } = await import("../../lib/tenant");
    const { db } = await import("../../lib/db");
    process.env.CREDIT_USD = "0.80";
    await setUnit(0.8);
    await granted("ws_s6");
    await saveShotCap("ws_s6", "25", AFTER);
    process.env.CREDIT_USD = "0.10";
    await convertAllCredits(run({ endAt: END, at: NOW, universe: ["ws_s6"], caps: { "ws_s6/settings:shotCapCredits": "x8" } }));
    expect(await shotCap("ws_s6")).toBe("200");
    // Paid work resumed: an Atomik run approved at 480 cr ($48) and the shot cap edited to 300 cr, in $0.10 credits. No job yet.
    const t = NOW + 60_000;
    await runInTenant(await tenantOf("ws_s6"), async () => {
      const { rigAgentReady } = await import("../../lib/workbench/rig-agent-store");
      await rigAgentReady();
      await db().execute({ sql: `INSERT INTO rig_agent_runs(id,production_id,draft_id,owner,request_id,goal,mode,cap_credits,per_job_cap,model,state,approved_at,created_at,updated_at)
        VALUES('s6_run','p','d','o','q','g','ask',480,200,'m','running',?,?,?)`, args: [t, t, t] });
    });
    await saveShotCap("ws_s6", "300", t);
    const before = (await balance("ws_s6", t)).balance;
    const out = await reverseAllCredits({ dryRun: false, at: NOW + 120_000, by: "owner", universe: ["ws_s6"] });
    expect(out.results[0].status).toBe("refused");
    expect(out.results[0].activity?.map((a) => [a.what, a.id]).sort()).toEqual([["Atomik run limit", "s6_run"], ["cap", "settings:shotCapCredits"]]);
    expect(await ledgerUnitTx(await platform())).toBe(0.1);
    expect((await balance("ws_s6", NOW + 130_000)).balance).toBe(before);
    expect(await shotCap("ws_s6")).toBe("300");
    await runInTenant(await tenantOf("ws_s6"), async () => {
      expect(Number((await db().execute(`SELECT cap_credits FROM rig_agent_runs WHERE id='s6_run'`)).rows[0].cap_credits)).toBe(480);
    });
  });

  /** A database as particl.si's is before the merge: credit tables, no ledger row yet. */
  const seedDb = async (name: string) => {
    const { createClient } = await import("@libsql/client");
    const { LEDGER_UNIT_SCHEMA } = await import("../../lib/ledgerUnit");
    const c = createClient({ url: `file:${path.join(dir, `${name}.db`)}` });
    await c.execute(LEDGER_UNIT_SCHEMA);
    await c.execute(`CREATE TABLE meter_events(id TEXT, workspace_id TEXT, credit_usd REAL, created_at INTEGER)`);
    await c.execute(`CREATE TABLE credit_grants(id TEXT, workspace_id TEXT, credits REAL, created_at INTEGER)`);
    await c.execute(`CREATE TABLE topup_requests(id TEXT, workspace_id TEXT, credits REAL, usd REAL, created_at INTEGER)`);
    return c;
  };

  test("M3: merged with CREDIT_USD already 0.10, a record written in the $0.80 days seeds $0.80 and pauses, though no job ran at $0.80", async () => {
    const { seedLedgerUnit, ledgerUnitTx, pausedSinceTx, ledgerOpenTx } = await import("../../lib/ledgerUnit");
    process.env.CREDIT_USD = "0.10";
    // The last job is a $0.10 one from before the cutover; inside the window only a desk grant and a pack request.
    for (const [name, sql] of [
      ["seed-grant", `INSERT INTO credit_grants VALUES('g','ws_x',100,${AFTER})`],
      ["seed-request", `INSERT INTO topup_requests VALUES('r','ws_x',500,400,${AFTER})`],
    ] as const) {
      const c = await seedDb(name);
      await c.execute(`INSERT INTO meter_events VALUES('old','ws_x',0.1,${BEFORE})`);
      await c.execute(sql);
      await seedLedgerUnit(c, NOW);
      expect([name, await ledgerUnitTx(c), await pausedSinceTx(c), await ledgerOpenTx(c)]).toEqual([name, 0.8, NOW, false]);
      // Later boots keep it: the row is written once.
      await seedLedgerUnit(c, NOW + 1000);
      expect([await ledgerUnitTx(c), await pausedSinceTx(c)]).toEqual([0.8, NOW]);
      c.close();
    }
  });

  test("M3: with nothing written in the $0.80 days (the house aside), it seeds at CREDIT_USD and nothing pauses", async () => {
    const { seedLedgerUnit, ledgerUnitTx, pausedSinceTx, ledgerOpenTx, OLD_PRICE_EARLIEST } = await import("../../lib/ledgerUnit");
    process.env.CREDIT_USD = "0.10";
    const c = await seedDb("seed-none");
    await c.execute(`INSERT INTO meter_events VALUES('old','ws_x',0.1,${OLD_PRICE_EARLIEST - 1}),('house','ws_legacy',0.8,${AFTER})`);
    await c.execute(`INSERT INTO credit_grants VALUES('w','ws_x',250,${BEFORE}),('h','ws_legacy',10,${AFTER})`);
    await seedLedgerUnit(c, NOW);
    expect([await ledgerUnitTx(c), await pausedSinceTx(c), await ledgerOpenTx(c)]).toEqual([0.1, null, true]);
    c.close();
    const empty = await seedDb("seed-empty");
    await seedLedgerUnit(empty, NOW);
    expect([await ledgerUnitTx(empty), await pausedSinceTx(empty)]).toEqual([0.1, null]);
    empty.close();
  });

  test("M3: a deployment at $0.80 seeds $0.80 whatever the last job cost; a ledger with no row admits nothing", async () => {
    const { seedLedgerUnit, ledgerUnitTx, pausedSinceTx, ledgerOpenTx } = await import("../../lib/ledgerUnit");
    process.env.CREDIT_USD = "0.80";
    const c = await seedDb("seed-080");
    await c.execute(`INSERT INTO meter_events VALUES('old','ws_x',0.1,${BEFORE})`);
    await seedLedgerUnit(c, 1000);
    expect([await ledgerUnitTx(c), await pausedSinceTx(c)]).toEqual([0.8, null]);
    process.env.CREDIT_USD = "0.10";
    await seedLedgerUnit(c, 2000);
    expect([await ledgerUnitTx(c), await pausedSinceTx(c)]).toEqual([0.8, 2000]);
    c.close();
    const bare = await seedDb("seed-bare");
    expect(await ledgerOpenTx(bare)).toBe(false);
    bare.close();
  });

  test("L5: a test mark needs the whole word", async () => {
    const { convertAllCredits } = await import("../../lib/creditConversion");
    const p = await platform();
    for (const [id, name] of [["ws_s8_latest", "Latest Media"], ["ws_s8_bench", "Studio test bench"]]) {
      await addWorkspace(id);
      await p.execute({ sql: `UPDATE workspaces SET name=? WHERE id=?`, args: [name, id] });
    }
    process.env.CREDIT_USD = "0.10";
    const dry = await convertAllCredits({ fromUsd: 0.8, toUsd: 0.1, mode: "per-row", cutoverAt: CUTOVER, endAt: END, dryRun: true, at: NOW, universe: ["ws_s8_latest", "ws_s8_bench"] });
    expect(dry.results.map((r) => [r.workspaceId, r.marks?.test])).toEqual([["ws_s8_latest", false], ["ws_s8_bench", true]]);
  });

  test("L8: a real run refuses a window the record cannot have", async () => {
    const { convertAllCredits, listCreditConversions } = await import("../../lib/creditConversion");
    process.env.CREDIT_USD = "0.10";
    await addWorkspace("ws_s9");
    const base = run({ at: NOW, universe: ["ws_s9"] });
    await expect(convertAllCredits({ ...base, cutoverAt: 2026, endAt: END })).rejects.toThrow(/is not when the price moved/);
    await expect(convertAllCredits({ ...base, cutoverAt: AFTER + 5000, endAt: END })).rejects.toThrow(/after the first job approved at the old price/);
    await expect(convertAllCredits({ ...base, cutoverAt: CUTOVER, endAt: CUTOVER - 1 })).rejects.toThrow(/is not after cutoverAt/);
    await expect(convertAllCredits({ ...base, cutoverAt: CUTOVER, endAt: NOW + DAY })).rejects.toThrow(/in the future/);
    expect(await listCreditConversions("ws_s9")).toEqual([]);
  });

  test("a job first metered at completion is refused while paused; a row that charges nothing is still recorded", async () => {
    const { runInTenant } = await import("../../lib/tenant");
    const { meter } = await import("../../lib/meter");
    const { LEDGER_UNIT_PAUSED } = await import("../../lib/ledgerUnit");
    await addWorkspace("ws_s10");
    await grant("ws_s10", "s10_grant", 100, "manual", BEFORE);
    process.env.CREDIT_USD = "0.10";
    await setUnit(0.8); // paused: the record counts in $0.80, CREDIT_USD is $0.10
    const p = await platform();
    const ws = await tenantOf("ws_s10");
    const done = await runInTenant(ws, () => meter({ id: "s10_done", kind: "text", engine: "openai", model: "fixture", status: "succeeded", engineCostUsd: 2 }))
      .then(() => null, (e: Error) => e);
    expect(done?.message).toBe(LEDGER_UNIT_PAUSED);
    expect((await p.execute(`SELECT id FROM meter_events WHERE id='s10_done'`)).rows).toHaveLength(0);
    await runInTenant(ws, () => meter({ id: "s10_free", kind: "text", engine: "openai", model: "fixture", status: "failed", engineCostUsd: 0 }));
    expect(Number((await p.execute(`SELECT billed_credits FROM meter_events WHERE id='s10_free'`)).rows[0].billed_credits)).toBe(0);
    await setUnit(0.1);
    // Open again: the same completion is charged in today's unit.
    await runInTenant(ws, () => meter({ id: "s10_done", kind: "text", engine: "openai", model: "fixture", status: "succeeded", engineCostUsd: 2 }));
    expect(Number((await p.execute(`SELECT credit_usd FROM meter_events WHERE id='s10_done'`)).rows[0].credit_usd)).toBe(0.1);
  });

  test("N1: after a rollback, a $0.80 job well after pausedSince refuses the default window", async () => {
    const { checkPausedWindowHolds, ROLLOUT_GRACE_MS } = await import("../../lib/creditConversion");
    const T = NOW + 100 * DAY; // pausedSince: the merged build's first boot
    await addWorkspace("ws_s11");
    // An old instance finishing a request just after the switch: inside the grace, fine.
    await job("ws_s11", "s11_overlap", 3, 0.80, T + ROLLOUT_GRACE_MS - 1000);
    await checkPausedWindowHolds(0.8, T);
    // The $0.80 build live again a day later (an Instant Rollback): refused, endAt asked for.
    await job("ws_s11", "s11_rollback", 3, 0.80, T + DAY);
    await expect(checkPausedWindowHolds(0.8, T)).rejects.toThrow(/give endAt: the time the redeployed build went live/);
    await checkPausedWindowHolds(0.8, T + DAY + 1000);
  });

  test("L12: the admin route may run for five minutes", async () => {
    const { readFileSync } = await import("node:fs");
    const route = readFileSync(path.resolve("app/api/admin/credit-unit/route.ts"), "utf8");
    expect(Number(/export const maxDuration = (\d+);/.exec(route)?.[1])).toBe(300);
  });
});
