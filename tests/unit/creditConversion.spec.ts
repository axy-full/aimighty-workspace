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
      VALUES(?,?,'video','byteplus','fixture',?,1,?,1,?,?,?,1.5)`,
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
  const p = await platform();
  // A plain balance: a welcome grant at US$0.10 before the cutover, an admin grant at US$0.80 after it.
  await grant("ws_plain", "plain_welcome", 250, "welcome", BEFORE);
  await grant("ws_plain", "plain_manual", 100, "manual", AFTER);
  await job("ws_plain", "plain_old_job", 20, 0.10, BEFORE + DAY);
  await job("ws_plain", "plain_new_job", 3, 0.80, AFTER + 1000);
  // A pack bought at US$0.80 (Starter: 500 cr for $400), one at US$0.10 ($50), and one still open at US$0.80.
  for (const [id, credits, usd, at, status] of [["req_old", 500, 50, BEFORE, "approved"], ["req_new", 500, 400, AFTER, "approved"], ["req_open", 500, 400, AFTER, "requested"]] as const)
    await p.execute({ sql: `INSERT INTO topup_requests(id,workspace_id,pack_id,label,credits,bonus_credits,usd,status,created_at) VALUES(?,?,'starter','Starter',?,0,?,?,?)`,
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
  const uniform = await convertAllCredits({ fromUsd: 0.80, toUsd: 0.10, mode: "uniform", dryRun: true, at: NOW, universe: ALL });
  const perRow = await convertAllCredits({ fromUsd: 0.80, toUsd: 0.10, mode: "per-row", cutoverAt: CUTOVER, dryRun: true, at: NOW, universe: ALL });
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
  expect(perRow.declinedTopups).toEqual([{ workspaceId: "ws_pack", id: "req_open", credits: 500, usd: 400, note: "Price changed; please ask again at US$0.10." }]);
  expect(uniform.results.find((r) => r.workspaceId === "ws_legacy")?.status ?? "house").toBe("house");
  expect(uniform.ledgerUnitAfter).toBe(0.8);
});

test("a real run converts per row, keeps every lot's kind and expiry, and resumes paid work", async () => {
  const { convertAllCredits } = await import("../../lib/creditConversion");
  const { ledgerOpenTx } = await import("../../lib/ledgerUnit");
  const plan = await dump("ws_plan");
  // Without the owner's decision, the balance it lowers is skipped whole, and paid work stays paused.
  const undecided = await convertAllCredits({ fromUsd: 0.80, toUsd: 0.10, mode: "per-row", cutoverAt: CUTOVER, dryRun: false, at: NOW, by: "owner", universe: ALL });
  expect(undecided.results.find((r) => r.workspaceId === "ws_plain")?.status).toBe("needs-decision");
  expect(undecided.waiting).toEqual(["ws_plain"]);
  expect(await ledgerOpenTx(await platform())).toBe(false);
  expect((await dump("ws_plain")).grants).toEqual([{ id: "plain_manual", credits: 100 }, { id: "plain_welcome", credits: 250 }]);
  const run = await convertAllCredits({ fromUsd: 0.80, toUsd: 0.10, mode: "per-row", cutoverAt: CUTOVER, dryRun: false, at: NOW, by: "owner", universe: ALL, decisions: { ws_plain: "goodwill" } });
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
  // It settles in the unit it was approved in, counted once in the new one: $2 at margin 1.5 is $3.00,
  // 4 credits at $0.80 ($3.20), booked as 32 credits at $0.10. Settling twice changes nothing.
  for (let i = 0; i < 2; i++)
    await runInTenant((await getWorkspace("ws_running"))!, () => meter({ id: "run_job", kind: "video", engine: "byteplus", model: "fixture", status: "succeeded", engineCostUsd: 2 }));
  expect((await balance("ws_running")).balance).toBe(800 - 32);
  // Twice is once.
  const again = await convertAllCredits({ fromUsd: 0.80, toUsd: 0.10, mode: "per-row", cutoverAt: CUTOVER, dryRun: false, at: NOW, universe: ALL, decisions: { ws_plain: "goodwill" } });
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
  await convertAllCredits({ fromUsd: 0.80, toUsd: 0.10, mode: "per-row", cutoverAt: CUTOVER, dryRun: false, at: NOW + 2000, universe: ALL, decisions: { ws_plain: "goodwill" } });
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
  const plan = { factorAt: (ts: number | null) => (ts != null && ts >= CUTOVER ? 8 : 1), conversionId: "unit:test:1", dryRun: false };
  process.env.CREDIT_USD = "0.10";
  const figures = await convertTenantFigures(ws, plan);
  expect(figures.find((f) => f.what === "settings.shotCapCredits")).toMatchObject({ before: 25, after: 200 });
  expect(figures.filter((f) => f.what === "api_tokens.cap_credits")).toEqual([{ what: "api_tokens.cap_credits", id: "tok", before: 50, after: 400 }]);
  // $0.50 at margin 1.5 is $0.75: 8 credits at $0.10, as Release will charge it.
  expect(figures.find((f) => f.what === "generations.params.held.needs")).toMatchObject({ before: 1, after: 8 });
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
  await expect(convertAllCredits({ fromUsd: 0.80, toUsd: 0.10, mode: "per-row", cutoverAt: CUTOVER, dryRun: false, universe: ALL })).rejects.toThrow(/CREDIT_USD/);
  await expect(convertAllCredits({ fromUsd: 0.80, toUsd: 0.10, mode: "uniform", dryRun: false, universe: ALL })).rejects.toThrow(/per row/);
  await expect(convertAllCredits({ fromUsd: 0.15, toUsd: 0.10, mode: "uniform", dryRun: true })).rejects.toThrow(/whole number/);
  process.env.CREDIT_USD = "0.10";
});
