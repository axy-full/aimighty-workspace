import { test, expect } from "@playwright/test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

/**
 * Cinema Studio's hold against every cap, and against the ledger's unit (the
 * independent money review of the hold, 6 October 2026). A take is approved
 * and held at 3N, so every cap reads it at 3N: the project cap, the shot cap,
 * the workspace's monthly allowance and the token ceilings, at admission and
 * again in the reservation's write. Two takes at once against a balance that
 * covers one hold admit one. A re-reservation keeps the hold. And a take held
 * before the price of a credit changed settles in the new unit, once, never
 * past its converted hold. Mocked, local temporary databases only.
 */
const dir = mkdtempSync(path.join(tmpdir(), "particl-cinema-hold-caps-"));
process.env.PLATFORM_DATABASE_URL = `file:${path.join(dir, "platform.db")}`;
process.env.TURSO_DATABASE_URL = `file:${path.join(dir, "legacy.db")}`;
process.env.KEYRING_SECRET ??= "unit-test-keyring-secret-unit-test-keyring";
process.env.ENGINE_MOCK = "1";

const CINEMA = "higgsfield-cinema-studio-4.0";
const MEMBER = { id: "member", email: "member@example.invalid", name: "Member", role: "member", owner: false, disabled: false, createdAt: 0, lastSeen: null };
/** One take's estimate in the engine's dollars (a fixture figure); N and 3N are read back from the meter. */
const USD = 2;

async function workspace(id: string, credits: number, allowanceUsd: number | null = null) {
  const { platformDb, platformReady, getWorkspace, grantCredits } = await import("../../lib/platform");
  const { billingReady } = await import("../../lib/billingLedger");
  await platformReady(); await billingReady();
  await platformDb().execute({ sql: `INSERT INTO workspaces(id,slug,name,db_url,owner_id,uses_platform_keys,created_at,updated_at,concurrency,renders_per_hour,allowance_usd) VALUES(?,?,?,?,'owner',1,0,0,20,200,?)`,
    args: [id, id, id, `file:${path.join(dir, `${id}.db`)}`, allowanceUsd] });
  if (credits > 0) await grantCredits(id, credits, "fixture", "owner", "manual");
  return (await getWorkspace(id))!;
}
async function inTenant<T>(ws: Awaited<ReturnType<typeof workspace>>, fn: () => Promise<T>) {
  const { runInTenant } = await import("../../lib/tenant");
  return runInTenant(ws, async () => { const { ready } = await import("../../lib/db"); await ready(); return fn(); }, { user: MEMBER } as never);
}
const take = (id: string, usd: number | null, extra: Record<string, unknown> = {}) =>
  ({ id, kind: "video" as const, engine: "higgsfield", model: CINEMA, status: "running" as const, engineCostUsd: usd, ...extra });
async function row(id: string) {
  const { platformDb } = await import("../../lib/platform");
  const r = (await platformDb().execute({ sql: `SELECT billed_credits,hold_band,engine_cost_usd,status,overrun_usd FROM meter_events WHERE id=?`, args: [id] })).rows[0];
  return r ? { billed: Number(r.billed_credits), band: r.hold_band == null ? null : Number(r.hold_band), cost: Number(r.engine_cost_usd), status: String(r.status), overrun: r.overrun_usd } : null;
}
const reserve = async (event: ReturnType<typeof take>, options: Record<string, unknown> = { holdBand: 3 }) => {
  const { reserveGenerationSpend } = await import("../../lib/generationRequests");
  return reserveGenerationSpend(event, options).then(() => "admitted", (e) => `${(e as { status?: number }).status}`);
};
/** N, as the meter holds it for one take of USD: a third of its hold. */
async function learnN(ws: Awaited<ReturnType<typeof workspace>>, id: string) {
  return inTenant(ws, async () => { expect(await reserve(take(id, USD))).toBe("admitted"); return (await row(id))!.billed / 3; });
}

test("the project cap reads a held take at 3N, at admission and in the reservation", async () => {
  const ws = await workspace("ws_cap", 10_000);
  const n = await learnN(ws, "cap_learn");
  await inTenant(ws, async () => {
    const { db } = await import("../../lib/db");
    const { checkCap } = await import("../../lib/caps");
    /* The cap covers 2N: N fits, the 3N hold does not. */
    await db().execute({ sql: `INSERT INTO projects(id,name,created_at,cap_credits) VALUES('capped','capped',0,?)`, args: [2 * n] });
    await db().execute(`INSERT INTO settings(key,value,updated_at) VALUES('atCap','stop',0) ON CONFLICT(key) DO UPDATE SET value='stop'`);
    expect((await checkCap("capped", USD, CINEMA)).allow).toBe(true);
    expect((await checkCap("capped", USD, CINEMA, 3)).allow).toBe(false);
    expect(await reserve(take("capped_take", USD, { projectId: "capped" }))).toBe("409");
    expect(await row("capped_take")).toBeNull();
    /* A cap that covers the hold admits it. */
    await db().execute({ sql: `INSERT INTO projects(id,name,created_at,cap_credits) VALUES('roomy','roomy',0,?)`, args: [3 * n] });
    expect((await checkCap("roomy", USD, CINEMA, 3)).allow).toBe(true);
    expect(await reserve(take("roomy_take", USD, { projectId: "roomy" }))).toBe("admitted");
  });
});

test("the shot cap reads a member's held take at 3N, at admission and in the reservation", async () => {
  const ws = await workspace("ws_shot", 10_000);
  const n = await learnN(ws, "shot_learn");
  await inTenant(ws, async () => {
    const { db } = await import("../../lib/db");
    const { shotCapGate } = await import("../../lib/shotCap");
    await db().execute({ sql: `INSERT INTO settings(key,value,updated_at) VALUES('approvalRule','cap',0),('shotCapCredits',?,0)`, args: [String(2 * n)] });
    const gate = (band?: number) => shotCapGate({ shotId: "shot1", code: "S1", takeUsd: USD, modelId: CINEMA, isAdmin: false, ...(band ? { band } : {}) });
    expect(await gate()).toBeNull();
    expect(await gate(3)).toMatch(/S1/);
    expect(await reserve(take("shot_take", USD, { shotId: "shot1" }), { holdBand: 3, shotCapExempt: false })).toBe("403");
    expect(await row("shot_take")).toBeNull();
  });
});

test("the workspace's monthly allowance reads a held take at its hold's dollars, at admission and in the reservation", async () => {
  const ws = await workspace("ws_allow", 10_000, USD * 2);
  await inTenant(ws, async () => {
    const { allowanceCheck } = await import("../../lib/allowance");
    expect((await allowanceCheck("higgsfield" as never, USD, CINEMA)).ok).toBe(true);
    expect(await allowanceCheck("higgsfield" as never, USD, CINEMA, 3)).toMatchObject({ ok: false, status: 429 });
    expect(await reserve(take("allow_take", USD))).toBe("429");
    expect(await row("allow_take")).toBeNull();
  });
});

test("the token ceilings read a held take at 3N", async () => {
  const ws = await workspace("ws_token", 10_000);
  const n = await learnN(ws, "token_learn");
  await inTenant(ws, async () => {
    const token = (capCredits: number) => ({ id: `tok_${capCredits}`, capUsd: null, capCredits });
    expect(await reserve(take("token_tight", USD), { holdBand: 3, token: token(2 * n) })).toBe("429");
    expect(await reserve(take("token_roomy", USD), { holdBand: 3, token: token(3 * n) })).toBe("admitted");
  });
});

test("two takes at once against a balance that covers one hold: one is admitted, the other refused, and the balance never goes below zero", async () => {
  const n = await learnN(await workspace("ws_learn", 10_000), "race_learn");
  const ws = await workspace("ws_race", Math.round(4.5 * n));
  await inTenant(ws, async () => {
    const { reserveGenerationSpend } = await import("../../lib/generationRequests");
    const r = await Promise.allSettled([reserveGenerationSpend(take("race_1", USD), { holdBand: 3 }), reserveGenerationSpend(take("race_2", USD), { holdBand: 3 })]);
    expect(r.filter((x) => x.status === "fulfilled")).toHaveLength(1);
    expect(r.filter((x) => x.status === "rejected").map((x) => (x as PromiseRejectedResult).reason.status)).toEqual([402]);
    const { billingStateFor } = await import("../../lib/billingLedger");
    expect((await billingStateFor("ws_race")).credits.balance).toBeGreaterThanOrEqual(0);
  });
});

test("a second reservation of a running held take keeps its hold and band", async () => {
  const ws = await workspace("ws_rereserve", 10_000);
  await inTenant(ws, async () => {
    expect(await reserve(take("again", USD))).toBe("admitted");
    const first = (await row("again"))!;
    expect(first.band).toBe(3);
    /* Re-reserved without the option: the hold stays as it was approved, and settlement stays capped. */
    expect(await reserve(take("again", USD), {})).toBe("admitted");
    expect(await row("again")).toMatchObject({ billed: first.billed, band: 3 });
  });
});

test("a take held at one price of a credit settles in the next, once: paused before any hold, the unit applied once, never past the converted hold", async () => {
  const MSG = "Paid work is paused for a few minutes while we update pricing. Nothing has been charged.";
  const before = process.env.CREDIT_USD;
  process.env.CREDIT_USD = "0.80";
  try {
    const { platformDb, platformReady, getWorkspace, grantCredits } = await import("../../lib/platform");
    const { billingReady, billingTransaction, billingStateFor } = await import("../../lib/billingLedger");
    const { setLedgerUnitTx } = await import("../../lib/ledgerUnit");
    await platformReady(); await billingReady();
    await billingTransaction((tx) => setLedgerUnitTx(tx, 0.8, "fixture", Date.now()));
    await platformDb().execute({ sql: `INSERT INTO workspaces(id,slug,name,db_url,owner_id,uses_platform_keys,created_at,updated_at,concurrency,renders_per_hour) VALUES('ws_unit','ws_unit','ws_unit',?,'owner',1,0,0,20,200)`,
      args: [`file:${path.join(dir, "ws_unit.db")}`] });
    await grantCredits("ws_unit", 1_000, "fixture", "owner", "manual");
    const ws = (await getWorkspace("ws_unit"))!;
    const { meter } = await import("../../lib/meter");
    await inTenant(ws, () => reserve(take("u_over", USD)));
    await inTenant(ws, () => reserve(take("u_nofig", USD)));
    const held = (await row("u_over"))!.billed;
    /* The price of a credit moves: new paid work pauses before any hold is taken. */
    process.env.CREDIT_USD = "0.10";
    expect(await inTenant(ws, async () => {
      const { reserveGenerationSpend } = await import("../../lib/generationRequests");
      return reserveGenerationSpend(take("u_paused", USD), { holdBand: 3 }).then(() => "admitted", (e) => `${(e as { status?: number }).status} ${(e as Error).message}`);
    })).toBe(`503 ${MSG}`);
    expect(await row("u_paused")).toBeNull();
    const { convertAllCredits } = await import("../../lib/creditConversion");
    const run = await convertAllCredits({ fromUsd: 0.8, toUsd: 0.1, mode: "per-row", cutoverAt: Date.UTC(2026, 9, 3, 14, 41, 44), endAt: Date.now(), dryRun: false, at: Date.now() + 1_000, by: "owner", universe: ["ws_unit"] });
    expect(run.ledgerUnitAfter).toBe(0.1);
    expect((await row("u_over"))!.billed).toBe(held * 8);
    /* Ten times its quote: capped at the converted hold, the over recorded; no figure: N, converted once. */
    await inTenant(ws, () => meter({ ...take("u_over", USD * 10), status: "succeeded" }));
    await inTenant(ws, () => meter({ ...take("u_nofig", null), status: "failed" }));
    const over = (await row("u_over"))!, nofig = (await row("u_nofig"))!;
    expect(over.billed).toBeLessThanOrEqual(held * 8);
    expect(over.overrun).not.toBeNull();
    expect(nofig.billed).toBe((held / 3) * 8);
    /* The same figure again moves nothing. */
    await inTenant(ws, () => meter({ ...take("u_over", USD * 10), status: "succeeded" }));
    expect((await row("u_over"))!.billed).toBe(over.billed);
    expect((await billingStateFor("ws_unit")).credits.balance).toBe(8 * 1_000 - over.billed - nofig.billed);
  } finally {
    if (before == null) delete process.env.CREDIT_USD; else process.env.CREDIT_USD = before;
  }
});
