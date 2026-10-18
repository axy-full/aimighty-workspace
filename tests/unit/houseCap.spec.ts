import { test, expect } from "@playwright/test";
import { alignLedgerUnit } from "../helpers/ledgerUnit";
import { fundFixtureWorkspace } from "../helpers/fundFixtureWorkspace";
import { mkdtempSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import type { TenantWorkspace } from "../../lib/tenant";

/**
 * The house workspace's monthly engine cap (lib/houseCap.ts), from the owner's decision of 15 October 2026: "Monthly cap on the house
 * workspace: $500, warning at 80%". Mocked engines and a local temporary platform database only; nothing here reaches a provider or a
 * mail server (the one mail the warning sends goes to a local stand-in).
 *
 * Unit files share one platform database per worker, and the house's id with it, so every figure below is read from the month so far
 * and the cap is set relative to it.
 */
const dir = mkdtempSync(path.join(tmpdir(), "particl-house-cap-"));
process.env.PLATFORM_DATABASE_URL = `file:${path.join(dir, "platform.db")}`;
process.env.TURSO_DATABASE_URL = `file:${path.join(dir, "primary.db")}`;
process.env.KEYRING_SECRET ??= "unit-test-keyring-secret-unit-test-keyring";
process.env.ENGINE_MOCK = "1";
process.env.SUPER_ADMIN_EMAIL = "house-cap-owner@example.test";
test.beforeAll(async () => { await alignLedgerUnit(); });
/* The house is one id for every unit file in a worker: what this file left running must not hold the next file's job slots. */
test.afterAll(async () => {
  const { platformDb, platformReady } = await import("../../lib/platform");
  await platformReady();
  await platformDb().execute("UPDATE meter_events SET status='failed' WHERE workspace_id='ws_legacy' AND status='running' AND id LIKE 'gen_housecap_%'");
});

const house = (allowanceUsd: number | null = null): TenantWorkspace => ({
  id: "ws_legacy", slug: "house", name: "House", legacy: true, dbUrl: `file:${path.join(dir, "house.db")}`, dbToken: null, keys: {}, usesPlatformKeys: true,
  allowanceUsd, gatewayKeyId: null, ownerId: "u_test", createdAt: 0, suspendedAt: null, suspendedReason: null, flaggedAt: null, flagNote: null,
  concurrency: 50, rendersPerHour: 1000, storageQuotaBytes: null, deletedAt: null,
} as TenantWorkspace);
const customer = (): TenantWorkspace => ({ ...house(), id: "ws_house_cap_customer", slug: "customer", name: "Customer", legacy: false } as TenantWorkspace);

async function houseRow(): Promise<void> {
  const { platformDb, platformReady } = await import("../../lib/platform");
  await platformReady();
  await platformDb().execute({
    sql: `INSERT OR IGNORE INTO workspaces (id, slug, name, db_url, db_token_enc, legacy, uses_platform_keys, owner_id, created_at, updated_at)
          VALUES ('ws_legacy', 'house-cap', 'House', '(primary)', NULL, 1, 1, 'u_test', ?, ?)`,
    args: [Date.now(), Date.now()],
  });
}

test("the cap's arithmetic and words: $500 by default, a warning from 80%, a stop at 100%", async () => {
  const { HOUSE_CAP_DEFAULT_USD, HOUSE_CAP_WARN_PCT, houseCapState, houseCapWarning, houseCapUsdText } = await import("../../lib/houseCapText");
  expect(HOUSE_CAP_DEFAULT_USD).toBe(500);
  expect(HOUSE_CAP_WARN_PCT).toBe(80);
  expect(houseCapState(500, 399.99)).toMatchObject({ warn: false, stop: false, pct: 79 });
  expect(houseCapState(500, 400)).toMatchObject({ warn: true, stop: false, pct: 80 });
  expect(houseCapState(500, 499.99)).toMatchObject({ warn: true, stop: false, pct: 99 });
  expect(houseCapState(500, 500)).toMatchObject({ warn: true, stop: true, pct: 100 });
  expect(houseCapState(500, 800)).toMatchObject({ stop: true, pct: 100 });
  /* $0 is a wall, as it is on every other workspace. */
  expect(houseCapState(0, 0)).toMatchObject({ stop: true });
  expect(houseCapWarning(houseCapState(500, 410))).toBe("82% of this month's $500 used ($410)");
  expect(houseCapWarning(houseCapState(62.5, 50))).toBe("80% of this month's $62.50 used ($50)");
  expect(houseCapUsdText(500)).toBe("$500");
  /* The stored figure: its own, 0 included, else the default; never none. */
  const { houseCapOfStored } = await import("../../lib/houseCap");
  expect(houseCapOfStored(null)).toEqual({ usd: 500, source: "default" });
  expect(houseCapOfStored(undefined)).toEqual({ usd: 500, source: "default" });
  expect(houseCapOfStored(0)).toEqual({ usd: 0, source: "own" });
  expect(houseCapOfStored(120.5)).toEqual({ usd: 120.5, source: "own" });
  /* The pure module is read by the browser: no imports, so no server code reaches it. */
  expect(readFileSync("lib/houseCapText.ts", "utf8")).not.toMatch(/^import /m);
});

test("set and refuse: the platform owner's writer stores the figure with its history line; the customer allowance's writer still refuses the house", async () => {
  await houseRow();
  const { platformDb, setHouseCap, setWorkspaceAllowance } = await import("../../lib/platform");
  const { HOUSE_NOT_BILLED } = await import("../../lib/houseWorkspace");
  const { houseCapViewFor } = await import("../../lib/houseCap");
  const lines = async () => (await platformDb().execute("SELECT actor_id,action,target_id,workspace_id,details FROM platform_audit WHERE action='housecap.set' AND workspace_id='ws_legacy' ORDER BY created_at,id")).rows;
  const before = (await lines()).length;
  await setHouseCap(250, "acct_house_cap_owner");
  expect(Number((await platformDb().execute("SELECT allowance_usd FROM workspaces WHERE id='ws_legacy'")).rows[0].allowance_usd)).toBe(250);
  expect(await houseCapViewFor(250)).toMatchObject({ capUsd: 250, source: "own" });
  await setHouseCap(null, "acct_house_cap_owner");
  expect((await platformDb().execute("SELECT allowance_usd FROM workspaces WHERE id='ws_legacy'")).rows[0].allowance_usd).toBeNull();
  expect(await houseCapViewFor(null)).toMatchObject({ capUsd: 500, source: "default" });
  const written = (await lines()).slice(before);
  expect(written.map((r) => [r.actor_id, r.target_id, JSON.parse(String(r.details))])).toEqual([
    ["acct_house_cap_owner", "ws_legacy", { capUsd: 250 }],
    ["acct_house_cap_owner", "ws_legacy", { capUsd: null }],
  ]);
  /* The customer allowance's writer is not the house's: it refuses it, as it always has. */
  await expect(setWorkspaceAllowance("ws_legacy", 10)).rejects.toThrow(HOUSE_NOT_BILLED);
  /* A history line holds checked figures only. */
  const { platformAuditStatement } = await import("../../lib/platformAudit");
  expect(() => platformAuditStatement({ actorId: "a", action: "housecap.set", targetType: "workspace", targetId: "ws_legacy", details: { capUsd: -1 } })).toThrow();
  expect(() => platformAuditStatement({ actorId: "a", action: "housecap.warned", targetType: "workspace", targetId: "ws_legacy", details: { atPct: 101 } })).toThrow();
  expect(() => platformAuditStatement({ actorId: "a", action: "housecap.set", targetType: "workspace", targetId: "ws_legacy", details: { note: "free text" } as never })).toThrow();
});

test("the gate: the house is refused at its cap and for a job that would pass it; a held take counts at its hold; any other workspace is untouched", async () => {
  const { runInTenant } = await import("../../lib/tenant");
  const { allowanceCheck } = await import("../../lib/allowance");
  const { houseCapCheck, houseCapView, houseSpendSince, houseMonthStart, HOUSE_CAP_REACHED } = await import("../../lib/houseCap");
  await houseRow();
  const spent = await houseSpendSince(houseMonthStart());
  /* Room for exactly $10 more. */
  const cap = Math.ceil((spent + 10) * 100) / 100;
  await runInTenant(house(cap), async () => {
    expect(await allowanceCheck("ark", 9.99)).toEqual({ ok: true });
    expect(await allowanceCheck("ark", 0)).toEqual({ ok: true });
    for (const refused of [await allowanceCheck("ark", 10.5), await allowanceCheck("gemini", 4, undefined, 3)])
      expect(refused).toEqual({ ok: false, status: 429, error: HOUSE_CAP_REACHED });
    expect(await houseCapCheck(10, 1)).toEqual({ ok: true });
    expect(await houseCapView()).toMatchObject({ capUsd: cap, source: "own", stop: false });
  });
  /* A $0 cap is a wall. */
  await runInTenant(house(0), async () => expect(await allowanceCheck("ark", 0.01)).toMatchObject({ ok: false, status: 429, error: HOUSE_CAP_REACHED }));
  /* No figure set: the default, $500, which a small job is well inside. */
  await runInTenant(house(null), async () => {
    expect(await houseCapView()).toMatchObject({ capUsd: 500, source: "default" });
    expect(await allowanceCheck("ark", 1)).toEqual({ ok: true });
  });
  /* Another workspace has no house cap at all, however much the house has spent. */
  await runInTenant(customer(), async () => {
    expect(await houseCapView()).toBeNull();
    expect(await houseCapCheck(1_000_000)).toEqual({ ok: true });
  });
  const words = HOUSE_CAP_REACHED;
  expect(words).not.toMatch(/\$|\d/);
});

test("the quote: a warning from 80%, a refusal at the cap or for a job that would pass it, none for a workspace without a house cap", async () => {
  const { verdictOf } = await import("../../lib/quote");
  const { HOUSE_CAP_REACHED } = await import("../../lib/houseCapText");
  const quote = (usd: number) => ({ totalCredits: 2, unitCredits: 2, units: 1, usd, lines: [{ key: "k", credits: 2, count: 1, usd, spent: 0, code: "S1", projectId: null, platformPays: false }] });
  const context = { balance: null, allowance: null, caps: {}, warnPct: 80, rule: "anyone" as const, shotCap: 0, isAdmin: true };
  expect(verdictOf(quote(1), { ...context, houseCap: { cap: 500, spent: 100 } })).toMatchObject({ allow: true, notice: "" });
  expect(verdictOf(quote(1), { ...context, houseCap: { cap: 500, spent: 410 } })).toMatchObject({ allow: true, notice: "82% of this month's $500 used ($411)" });
  /* The job itself carries the month over the line: warned before it starts. */
  expect(verdictOf(quote(20), { ...context, houseCap: { cap: 500, spent: 385 } })).toMatchObject({ allow: true, notice: "81% of this month's $500 used ($405)" });
  expect(verdictOf(quote(10), { ...context, houseCap: { cap: 500, spent: 495 } })).toMatchObject({ allow: false, gate: "allowance", line: HOUSE_CAP_REACHED });
  expect(verdictOf(quote(0.01), { ...context, houseCap: { cap: 500, spent: 500 } })).toMatchObject({ allow: false, gate: "allowance", line: HOUSE_CAP_REACHED });
  expect(verdictOf(quote(1), { ...context, houseCap: null })).toMatchObject({ allow: true, notice: "" });
  expect(verdictOf(quote(1), context)).toMatchObject({ allow: true, notice: "" });
});

test("the reservation: 80% tells the platform owner once a month, 100% stops the job, a refused job writes nothing; the customer allowance never sees it; a mail that hangs holds up no reservation", async () => {
  const mail: { to: string[]; subject: string; text: string }[] = [];
  /* While `hang` is set, the stand-in mail server takes a message and never answers (until `answer`), as a slow one would for its 15 s. */
  let hang = false;
  const hung: (() => void)[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      mail.push(JSON.parse(Buffer.concat(chunks).toString()));
      const reply = () => { res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify({ id: "mail_test" })); };
      if (hang) hung.push(reply); else reply();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  process.env.RESEND_BASE_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  process.env.RESEND_API_KEY = "test-mail-key";
  process.env.MAIL_FROM = "Particl <desk@example.test>";
  try {
    const { runInTenant } = await import("../../lib/tenant");
    const { db, ready } = await import("../../lib/db");
    const { platformDb, platformReady, setHouseCap } = await import("../../lib/platform");
    const { reserveGenerationSpend, SpendReservationError } = await import("../../lib/generationRequests");
    const { houseSpendSince, houseMonthStart, houseNotesSettled, noteHouseSpend, HOUSE_CAP_REACHED } = await import("../../lib/houseCap");
    await platformReady();
    await houseRow();
    const model = "gemini-3.1-flash-image";
    const usd = 0.04;
    const tag = Date.now().toString(36);
    /* Another workspace, on its own database, funded for its one job. */
    const other = { ...customer(), id: `ws_house_cap_other_${tag}`, dbUrl: `file:${path.join(dir, `other-${tag}.db`)}` } as TenantWorkspace;
    /* The warning is sent after the reservation's turn, never awaited by it: wait for it here before reading what it wrote. */
    const job = async (id: string) => {
      await db().execute({ sql: `INSERT INTO generations(id,kind,provider,model,prompt,params,status,created_at,updated_at) VALUES(?,'image','google',?,'a still','{}','running',?,?)`, args: [id, model, Date.now(), Date.now()] });
      try { await reserveGenerationSpend({ id, kind: "image" as const, engine: "google", model, status: "running" as const, engineCostUsd: usd }); }
      finally { await houseNotesSettled(); }
    };
    const meterRows = async () => Number((await platformDb().execute("SELECT COUNT(*) AS n FROM meter_events WHERE workspace_id='ws_legacy'")).rows[0].n);
    const warned = async () => Number((await platformDb().execute({ sql: "SELECT COUNT(*) AS n FROM platform_audit WHERE action='housecap.warned' AND created_at>=?", args: [houseMonthStart()] })).rows[0].n);
    const base = await houseSpendSince(houseMonthStart());
    /* Room for the sums below, which put this file's own jobs at under 80% of base + $10. */
    expect(base).toBeLessThan(30);

    await runInTenant(house(), async () => {
      await ready();
      /* Plenty of room: reserved, and well under 80%, so nobody is told. */
      await setHouseCap(base + 10, "acct_house_cap_owner");
      await job(`gen_housecap_a_${tag}`);
      expect(await warned()).toBe(0);
      expect(mail).toEqual([]);

      /* The cap lowered so this job takes the month past 80% and not past 100%: reserved, and the platform owner is told, once. The mail
         server hangs on that message: the house's reservation returns at once, and another workspace's reservation is not held up behind it. */
      const spent = await houseSpendSince(houseMonthStart());
      await setHouseCap(Math.round((spent + usd + 0.005) * 1000) / 1000, "acct_house_cap_owner");
      hang = true;
      const started = Date.now();
      await reserveGenerationSpend({ id: `gen_housecap_b_${tag}`, kind: "image" as const, engine: "google", model, status: "running" as const, engineCostUsd: usd });
      await expect.poll(() => mail.length, { timeout: 5_000 }).toBe(1);
      expect(hung).toHaveLength(1);
      await runInTenant(other, async () => {
        await ready();
        await fundFixtureWorkspace(100);
        await reserveGenerationSpend({ id: `gen_housecap_other_${tag}`, kind: "image" as const, engine: "google", model, status: "running" as const, engineCostUsd: usd });
      });
      /* Both reserved while the mail still hangs: well inside the mail's 15 s timeout, which the reservations used to wait out. */
      expect(hung).toHaveLength(1);
      expect(Date.now() - started).toBeLessThan(10_000);
      expect(Number((await platformDb().execute({ sql: "SELECT COUNT(*) AS n FROM meter_events WHERE id IN (?,?) AND status='running'", args: [`gen_housecap_b_${tag}`, `gen_housecap_other_${tag}`] })).rows[0].n)).toBe(2);
      hang = false;
      hung.splice(0).forEach((reply) => reply());
      await houseNotesSettled();
      expect(await warned()).toBe(1);
      expect(mail).toHaveLength(1);
      expect(mail[0].to).toEqual(["house-cap-owner@example.test"]);
      expect(mail[0].subject).toMatch(/^Particl: \d+% of this month's \$\d/);
      expect(mail[0].text).toMatch(/80% of its \$/);
      /* No prompt, key or person's name in the mail: figures and the cap's words only. */
      expect(mail[0].text).not.toMatch(/test-mail-key|a still/);

      /* 100%: the next job would pass the cap. Refused with the cap's words, 429, and nothing is reserved. */
      const rows = await meterRows();
      const refused = await job(`gen_housecap_c_${tag}`).then(() => null, (e) => e);
      expect(refused).toBeInstanceOf(SpendReservationError);
      expect(refused).toMatchObject({ status: 429, message: HOUSE_CAP_REACHED });
      expect(await meterRows()).toBe(rows);
      /* Refused again: still one warning and one mail. */
      expect(await warned()).toBe(1);
      expect(mail).toHaveLength(1);

      /* A cap raised by the owner is read at once by the next reservation. */
      await setHouseCap(base + 100, "acct_house_cap_owner");
      await job(`gen_housecap_d_${tag}`);
      expect(await meterRows()).toBe(rows + 1);
      /* Crossing again inside the same month writes no second line and sends no second mail. */
      expect(await noteHouseSpend(base + 99, base + 100)).toBe(false);
      expect(await warned()).toBe(1);
      expect(mail).toHaveLength(1);
      /* Next month it speaks again. */
      expect(await noteHouseSpend(base + 99, base + 100, Date.now() + 40 * 86_400_000)).toBe(true);
      expect(await warned()).toBe(2);
      expect(mail).toHaveLength(2);
      /* Under the line it never speaks. */
      expect(await noteHouseSpend(1, 500, Date.now() + 80 * 86_400_000)).toBe(false);
      expect(mail).toHaveLength(2);
    });

    /* A mail server that is down never fails a reserved job. */
    process.env.RESEND_BASE_URL = "http://127.0.0.1:9";
    const calm = await noteHouseSpend(499, 500, Date.now() + 120 * 86_400_000);
    expect(calm).toBe(true);
  } finally {
    hung.splice(0).forEach((reply) => reply());
    await new Promise<void>((resolve) => server.close(() => resolve()));
    delete process.env.RESEND_BASE_URL; delete process.env.RESEND_API_KEY; delete process.env.MAIL_FROM;
    const { platformDb } = await import("../../lib/platform");
    await platformDb().execute("UPDATE workspaces SET allowance_usd=NULL WHERE id='ws_legacy'");
  }
});

test("a held take (Cinema Studio, band 3) counts at its hold for the house: the cap is checked at cost x band, the row records the band, concurrent holds near the cap admit one, settlement gives the room back", async () => {
  const { runInTenant } = await import("../../lib/tenant");
  const { db, ready } = await import("../../lib/db");
  const { platformDb, platformReady, setHouseCap } = await import("../../lib/platform");
  const { reserveGenerationSpend, SpendReservationError } = await import("../../lib/generationRequests");
  const { houseSpendSince, houseMonthStart, HOUSE_CAP_REACHED } = await import("../../lib/houseCap");
  const { meter } = await import("../../lib/meter");
  await platformReady();
  await houseRow();
  const model = "gemini-3.1-flash-image";
  const usd = 0.04;
  const tag = `${Date.now().toString(36)}h`;
  const reserve = async (id: string, band: number) => {
    await db().execute({ sql: `INSERT INTO generations(id,kind,provider,model,prompt,params,status,created_at,updated_at) VALUES(?,'image','google',?,'a still','{}','running',?,?)`, args: [id, model, Date.now(), Date.now()] });
    await reserveGenerationSpend({ id, kind: "image" as const, engine: "google", model, status: "running" as const, engineCostUsd: usd }, band > 1 ? { holdBand: band } : {});
  };
  const row = async (id: string) => (await platformDb().execute({ sql: "SELECT hold_band,engine_cost_usd,status FROM meter_events WHERE id=?", args: [id] })).rows[0];
  const refusal = (promise: Promise<void>) => promise.then(() => null, (e) => e);
  try {
    await runInTenant(house(), async () => {
      await ready();
      const base = await houseSpendSince(houseMonthStart());
      /* Room for one hold (3 x $0.04 = $0.12) and a little more, not for two. */
      await setHouseCap(Math.ceil((base + 0.15) * 1000) / 1000, "acct_house_cap_owner");
      await reserve(`gen_housecap_hold_a_${tag}`, 3);
      /* The row records its band, so every later reservation counts it running at its hold. */
      expect(Number((await row(`gen_housecap_hold_a_${tag}`)).hold_band)).toBe(3);
      expect(await houseSpendSince(houseMonthStart())).toBeCloseTo(base + 0.12, 6);
      /* A second hold, and a plain take that would pass the cap with the first at its hold, are refused; counted at their quote they would have fit. */
      for (const [id, band] of [[`gen_housecap_hold_b_${tag}`, 3], [`gen_housecap_plain_${tag}`, 1]] as const) {
        const refused = await refusal(reserve(id, band));
        expect(refused, id).toBeInstanceOf(SpendReservationError);
        expect(refused, id).toMatchObject({ status: 429, message: HOUSE_CAP_REACHED });
        expect(await row(id)).toBeUndefined();
      }
      /* It settles at what it cost, never past its hold: the rest of the hold is room again. */
      await meter({ id: `gen_housecap_hold_a_${tag}`, kind: "image", engine: "google", model, status: "succeeded", engineCostUsd: 0.05 });
      expect(Number((await row(`gen_housecap_hold_a_${tag}`)).engine_cost_usd)).toBeCloseTo(0.05, 6);
      expect(await houseSpendSince(houseMonthStart())).toBeCloseTo(base + 0.05, 6);
      await reserve(`gen_housecap_plain_ok_${tag}`, 1);
      /* Two held takes raced with room for one: exactly one is admitted. */
      const now = await houseSpendSince(houseMonthStart());
      await setHouseCap(Math.ceil((now + 0.15) * 1000) / 1000, "acct_house_cap_owner");
      const raced = await Promise.all([refusal(reserve(`gen_housecap_race_a_${tag}`, 3)), refusal(reserve(`gen_housecap_race_b_${tag}`, 3))]);
      expect(raced.filter((r) => r === null)).toHaveLength(1);
      expect(raced.find((r) => r !== null)).toMatchObject({ status: 429, message: HOUSE_CAP_REACHED });
      expect(await houseSpendSince(houseMonthStart())).toBeCloseTo(now + 0.12, 6);
    });
  } finally {
    const { platformDb: p } = await import("../../lib/platform");
    await p().execute("UPDATE workspaces SET allowance_usd=NULL WHERE id='ws_legacy'");
  }
});

test("a customer workspace's reservation is untouched: no house cap read, its own allowance still the wall", () => {
  const reservation = readFileSync("lib/generationRequests.ts", "utf8");
  /* The house's check is its own branch, tied to the house workspace and to nothing else. */
  expect(reservation).toContain("const houseCapNow = isHouseWorkspace(ws) ? houseCapOfStored(standing.rows[0]?.allowance_usd).usd : null;");
  expect(reservation).toContain("if (houseCapNow != null) {");
  /* A held house take counts at its hold, and its row records the band. */
  expect(reservation).toContain("const needs = cost * (houseHeld ? keptBand : 1);");
  expect(reservation).toContain("heldAtCeiling || houseHeld ? keptBand : null");
  expect(reservation).toContain("if (capNow != null && ");
  const allowance = readFileSync("lib/allowance.ts", "utf8");
  expect(allowance).toContain("if (isHouseWorkspace(currentTenant()?.workspace)) return houseCapCheck(estUsd, band);");
  /* No environment name is invented: the figure is the workspace's stored allowance and a constant. */
  expect(readFileSync("lib/houseCap.ts", "utf8")).not.toMatch(/process\.env\.(?!SUPER_ADMIN_EMAIL)/);
});
