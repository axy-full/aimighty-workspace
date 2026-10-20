import { test, expect } from "@playwright/test";
import { alignLedgerUnit } from "../helpers/ledgerUnit";
import { fundFixtureWorkspace } from "../helpers/fundFixtureWorkspace";
import { loadRouteModule } from "../helpers/vendorCostScan";
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

test("the house quote counts a held take at its band against the house cap, as admission does; every other workspace's quote and verdict are unchanged", async () => {
  const { quoteOf, verdictOf, withHouseBands, publicQuote } = await import("../../lib/quote");
  const { CINEMA_STUDIO_MODEL_ID } = await import("../../lib/cinemaStudioTypes");
  const { holdBandOf } = await import("../../lib/cinemaHold");
  const { HOUSE_CAP_REACHED } = await import("../../lib/houseCapText");
  const { runInTenant } = await import("../../lib/tenant");
  const { houseCapCheck, houseCapView } = await import("../../lib/houseCap");
  const band = holdBandOf(CINEMA_STUDIO_MODEL_ID);
  expect(band).toBeGreaterThan(1);
  /* Synthetic terms and costs, built here: a credit at $0.10 and a margin of 2 on every engine. */
  const SYNTHETIC_TERMS = { perCredit: 0.1, table: { "*": 2 } };
  const held = { key: "shot_held", usd: 4, engine: CINEMA_STUDIO_MODEL_ID };
  const plain = { key: "shot_plain", usd: 4, engine: "gemini-3.1-flash-image" };
  const base = { balance: null, allowance: null, caps: {}, warnPct: 80, rule: "anyone" as const, shotCap: 0, isAdmin: true };
  const priced = (units: (typeof held)[], context: Parameters<typeof verdictOf>[1]) => verdictOf(quoteOf(units, SYNTHETIC_TERMS), withHouseBands(context, units));

  /* The cap: $10 of room. The held take needs its hold ($4 x band), the plain one its quote. */
  const nearCap = { ...base, houseCap: { cap: 500, spent: 490 } };
  expect(priced([plain], nearCap)).toMatchObject({ allow: true });
  expect(priced([held], nearCap)).toMatchObject({ allow: false, gate: "allowance", line: HOUSE_CAP_REACHED });
  /* Counted at its quote, as before, it would have been allowed and then refused at admission. */
  expect(verdictOf(quoteOf([held], SYNTHETIC_TERMS), nearCap)).toMatchObject({ allow: true });
  /* The warning names the month with the hold in it. */
  expect(priced([held], { ...base, houseCap: { cap: 500, spent: 485 } })).toMatchObject({ allow: true, notice: `${Math.floor((485 + 4 * band) / 5)}% of this month's $500 used ($${485 + 4 * band})` });
  /* The bands are the house cap's alone: with room under the cap, a held take passes like a plain one. */
  const roomy = { ...base, isAdmin: false, houseCap: { cap: 1_000_000, spent: 0 } };
  const big = (u: typeof held) => ({ ...u, usd: 8 });
  expect(priced([big(plain)], roomy)).toMatchObject({ allow: true, notice: "" });
  expect(priced([big(held)], roomy)).toMatchObject({ allow: true, notice: "" });

  /* The same answer as admission's own gate, against the house's real month. */
  await houseRow();
  const { houseSpendSince, houseMonthStart } = await import("../../lib/houseCap");
  const cap = Math.ceil(((await houseSpendSince(houseMonthStart())) + 10) * 100) / 100;
  await runInTenant(house(cap), async () => {
    const view = (await houseCapView())!;
    const context = { ...base, houseCap: { cap: view.capUsd, spent: view.spentUsd } };
    for (const unit of [plain, held]) {
      const admitted = await houseCapCheck(unit.usd, holdBandOf(unit.engine));
      expect(priced([unit], context).allow, unit.key).toBe(admitted.ok);
    }
  });

  /* Every other workspace: no house cap, so the context comes back as the same object, and the quote and verdict are byte-identical. */
  const customers = [
    { ...base, allowance: { cap: 50, spent: 10 }, houseCap: null },
    { ...base, allowance: { cap: 1, spent: 0 }, houseCap: null },
    { ...base, isAdmin: false, houseCap: null },
    { ...base, isAdmin: false },
  ];
  for (const context of customers) for (const units of [[held], [plain], [held, plain], [big(held), big(plain)]]) {
    expect(withHouseBands(context, units)).toBe(context);
    expect(JSON.stringify(verdictOf(quoteOf(units, SYNTHETIC_TERMS), withHouseBands(context, units)))).toBe(JSON.stringify(verdictOf(quoteOf(units, SYNTHETIC_TERMS), context)));
    expect(JSON.stringify(publicQuote(quoteOf(units, SYNTHETIC_TERMS)))).not.toMatch(/band|usd/);
  }
});

test("the reservation: 80% tells the platform owner once a month (and once more after a raise), 100% stops the job, a refused job writes nothing; the customer allowance never sees it; a mail that hangs holds up no reservation", async () => {
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
      const lowered = Math.round((spent + usd + 0.005) * 1000) / 1000;
      await setHouseCap(lowered, "acct_house_cap_owner");
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

      /* A cap raised by the owner is read at once by the next reservation; well under 80% of the new figure, nobody is told. */
      await setHouseCap(base + 100, "acct_house_cap_owner");
      await job(`gen_housecap_d_${tag}`);
      expect(await meterRows()).toBe(rows + 1);
      expect(await warned()).toBe(1);
      /* The figure already warned at, crossed again inside the same month: no second line, no second mail. */
      expect(await noteHouseSpend(lowered, lowered)).toBe(false);
      expect(await warned()).toBe(1);
      expect(mail).toHaveLength(1);
      /* A raise past every figure warned at this month (owner, 19 Oct 2026): crossing its own 80% tells the platform owner again, once. */
      expect(await noteHouseSpend(base + 99, base + 100)).toBe(true);
      expect(await warned()).toBe(2);
      expect(mail).toHaveLength(2);
      expect(await noteHouseSpend(base + 99.5, base + 100)).toBe(false);
      expect(await warned()).toBe(2);
      expect(mail).toHaveLength(2);
      /* Another month it speaks again: one line, dated in that month (an earlier one, so no line here is dated ahead of the clock). */
      expect(await noteHouseSpend(base + 99, base + 100, Date.now() - 40 * 86_400_000)).toBe(true);
      expect(await warned()).toBe(2);
      expect(mail).toHaveLength(3);
      /* Under the line it never speaks. */
      expect(await noteHouseSpend(1, 500, Date.now() - 80 * 86_400_000)).toBe(false);
      expect(mail).toHaveLength(3);
    });

    /* A mail server that is down never fails a reserved job. */
    process.env.RESEND_BASE_URL = "http://127.0.0.1:9";
    const calm = await noteHouseSpend(499, 500, Date.now() - 120 * 86_400_000);
    expect(calm).toBe(true);
  } finally {
    hung.splice(0).forEach((reply) => reply());
    await new Promise<void>((resolve) => server.close(() => resolve()));
    delete process.env.RESEND_BASE_URL; delete process.env.RESEND_API_KEY; delete process.env.MAIL_FROM;
    const { platformDb } = await import("../../lib/platform");
    await platformDb().execute("UPDATE workspaces SET allowance_usd=NULL WHERE id='ws_legacy'");
  }
});

test("after a raise the 80% warning comes once more; after a lowering it never comes again that month; jobs crossing together write one line and one email", async () => {
  const mail: { subject: string }[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => { mail.push(JSON.parse(Buffer.concat(chunks).toString())); res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify({ id: "mail_test" })); });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  process.env.RESEND_BASE_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  process.env.RESEND_API_KEY = "test-mail-key";
  process.env.MAIL_FROM = "Particl <desk@example.test>";
  const clock = Date.now;
  const ids: string[] = [];
  const model = "gemini-3.1-flash-image";
  try {
    const { runInTenant } = await import("../../lib/tenant");
    const { db, ready } = await import("../../lib/db");
    const { platformDb, platformReady, setHouseCap } = await import("../../lib/platform");
    const { reserveGenerationSpend } = await import("../../lib/generationRequests");
    const { cycleBounds } = await import("../../lib/cycle");
    const { houseNotesSettled, houseSpendSince, houseMonthStart, noteHouseSpend } = await import("../../lib/houseCap");
    await platformReady();
    await houseRow();
    const tag = `${clock().toString(36)}r`;
    /* The whole month below runs on a clock set to a month long past (the clock still moves), so the reservations' rows, their notes and
       their lines all sit in that month, where nothing else this file or another writes stands in the way, and this month's figures are
       left as they were. Synthetic figures throughout: jobs of $2 and $0.04, and caps built from the spend they find. */
    const month = Date.UTC(2023, 2, 10);
    const offset = month - clock();
    Date.now = () => clock() + offset;
    const job = async (usd: number) => {
      const id = `gen_housecap_raise_${ids.length}_${tag}`;
      ids.push(id);
      await db().execute({ sql: `INSERT INTO generations(id,kind,provider,model,prompt,params,status,created_at,updated_at) VALUES(?,'image','google',?,'a still','{}','running',?,?)`, args: [id, model, Date.now(), Date.now()] });
      try { await reserveGenerationSpend({ id, kind: "image" as const, engine: "google", model, status: "running" as const, engineCostUsd: usd }); }
      finally { await houseNotesSettled(); }
    };
    const lines = async (capUsd?: number, at = Date.now()) => {
      const m = cycleBounds(1, at);
      return Number((await platformDb().execute({
        sql: `SELECT COUNT(*) AS n FROM platform_audit WHERE action='housecap.warned' AND workspace_id='ws_legacy' AND created_at>=? AND created_at<?${capUsd == null ? "" : " AND ABS(json_extract(details,'$.capUsd')-?)<1e-9"}`,
        args: [m.start, m.end, ...(capUsd == null ? [] : [capUsd])] })).rows[0].n);
    };
    const spent = () => houseSpendSince(houseMonthStart());
    /* A figure the month's spend plus a $2 job puts at 90% of (odd enough that no other test sets it). */
    const crossedBy = async () => Math.round(((await spent()) + 2) / 0.9 * 1e6) / 1e6 + 0.000123;

    await runInTenant(house(), async () => {
      await ready();
      expect(await lines()).toBe(0);
      /* The month's first crossing: one line, one email. */
      const first = await crossedBy();
      await setHouseCap(first, "acct_house_cap_owner");
      await job(2);
      expect(await lines(first)).toBe(1);
      expect(mail).toHaveLength(1);

      /* A raise (owner, 19 Oct 2026: "a second 80% warning after a raise"): crossing the new figure's 80% tells the platform owner once more. */
      const raised = await crossedBy();
      expect(raised).toBeGreaterThan(first);
      await setHouseCap(raised, "acct_house_cap_owner");
      await job(2);
      expect(await lines(raised)).toBe(1);
      expect(await lines()).toBe(2);
      expect(mail).toHaveLength(2);
      expect(mail[1].subject).toMatch(/^Particl: \d+% of this month's \$/);

      /* A lowering ("House cap: no warning on a lowering"): to a figure never warned at, a job past its 80% and under its 100% is reserved,
         and nobody is told. */
      const now = await spent();
      const lowered = Math.round((now + 0.04 + (raised - now - 0.04) / 2) * 1e6) / 1e6;
      expect(lowered).toBeLessThan(raised);
      await setHouseCap(lowered, "acct_house_cap_owner");
      await job(0.04);
      expect((await spent()) / lowered).toBeGreaterThanOrEqual(0.8);
      expect(await lines(lowered)).toBe(0);
      expect(await lines()).toBe(2);
      expect(mail).toHaveLength(2);
      /* Lowered further, near the spend: still nobody is told. */
      const lower = Math.round(((await spent()) + 0.05) * 1e6) / 1e6;
      await setHouseCap(lower, "acct_house_cap_owner");
      await job(0.04);
      expect(await lines()).toBe(2);
      expect(mail).toHaveLength(2);
      /* Put back up to a figure already warned at, or one under it: not a raise past anything the owner has heard about. Quiet. */
      await setHouseCap(raised, "acct_house_cap_owner");
      await job(0.04);
      expect(await noteHouseSpend(raised - 0.01, raised - 0.005)).toBe(false);
      expect(await lines()).toBe(2);
      expect(mail).toHaveLength(2);

      /* Raised past every figure warned at this month: told once more, and once only. */
      const again = await crossedBy();
      expect(again).toBeGreaterThan(raised);
      await setHouseCap(again, "acct_house_cap_owner");
      await job(2);
      expect(await lines(again)).toBe(1);
      expect(await lines()).toBe(3);
      expect(mail).toHaveLength(3);
      expect(await noteHouseSpend(again * 0.95, again)).toBe(false);
      expect(mail).toHaveLength(3);

      /* Jobs crossing a higher figure together write one line and send one email: the marker is one statement. */
      const higher = again + 1;
      const raced = await Promise.all(Array.from({ length: 6 }, () => noteHouseSpend(higher * 0.85, higher)));
      expect(raced.filter(Boolean)).toHaveLength(1);
      expect(await lines(higher)).toBe(1);
      expect(mail).toHaveLength(4);
      /* Every figure at or under the highest warned at, raced or not: quiet. */
      expect((await Promise.all([noteHouseSpend(raised, raised), noteHouseSpend(first, first), noteHouseSpend(lowered, lowered), noteHouseSpend(higher, higher)])).filter(Boolean)).toHaveLength(0);
      expect(await lines()).toBe(4);
      expect(mail).toHaveLength(4);
    });

    /* A reset to the default is a figure like any other (in another month long past): a raise to it warns once more, a lowering from it does not. */
    Date.now = clock;
    const later = Date.UTC(2024, 5, 15);
    expect(await noteHouseSpend(0.9 * 250, 250, later)).toBe(true);
    expect(await noteHouseSpend(400, 500, later)).toBe(true);
    expect(await noteHouseSpend(410, 500, later)).toBe(false);
    expect(await noteHouseSpend(0.9 * 250, 250, later)).toBe(false);
    expect(await noteHouseSpend(0.9 * 300, 300, later)).toBe(false);
    expect(await lines(250, later)).toBe(1);
    expect(await lines(500, later)).toBe(1);
    expect(await lines(undefined, later)).toBe(2);
    expect(mail).toHaveLength(6);
  } finally {
    Date.now = clock;
    /* The jobs end with nothing charged. */
    const { meter } = await import("../../lib/meter");
    const { runInTenant } = await import("../../lib/tenant");
    await runInTenant(house(), async () => {
      for (const id of ids) await meter({ id, kind: "image", engine: "google", model, status: "failed", engineCostUsd: 0 });
    });
    await new Promise<void>((resolve) => server.close(() => resolve()));
    delete process.env.RESEND_BASE_URL; delete process.env.RESEND_API_KEY; delete process.env.MAIL_FROM;
    const { platformDb } = await import("../../lib/platform");
    await platformDb().execute("UPDATE workspaces SET allowance_usd=NULL WHERE id='ws_legacy'");
  }
});

test("the month is the reservation's: a note that runs just after midnight on the 1st marks the month the spend belongs to, and the new month still speaks", async () => {
  const { runInTenant } = await import("../../lib/tenant");
  const { db, ready } = await import("../../lib/db");
  const { platformDb, platformReady, setHouseCap } = await import("../../lib/platform");
  const { reserveGenerationSpend } = await import("../../lib/generationRequests");
  const { houseNotesSettled, houseSpendSince, houseMonthStart, noteHouseSpend } = await import("../../lib/houseCap");
  const { meter } = await import("../../lib/meter");
  await platformReady();
  await houseRow();
  /* Months long past, so no line already written stands in the way (and none is dated ahead of the clock): the last moments of a January, then the first of February. */
  const [jan, feb, mar, apr, may] = [0, 1, 2, 3, 4].map((m) => Date.UTC(2025, m, 1));
  const lines = async (from: number, to: number) => Number((await platformDb().execute({
    sql: "SELECT COUNT(*) AS n FROM platform_audit WHERE action='housecap.warned' AND workspace_id='ws_legacy' AND created_at>=? AND created_at<?", args: [from, to] })).rows[0].n);
  const model = "gemini-3.1-flash-image";
  /* Synthetic figures: a $0.04 job, and a cap that the house's spend since that January plus the job puts at 90% of it. */
  const usd = 0.04;
  const cap = Math.ceil((((await houseSpendSince(jan)) + usd) / 0.9) * 1e6) / 1e6;
  const id = `gen_housecap_midnight_${Date.now().toString(36)}`;
  const before = await houseSpendSince(houseMonthStart());
  const clock = Date.now;
  try {
    await runInTenant(house(), async () => {
      await ready();
      await setHouseCap(cap, "acct_house_cap_owner");
      await db().execute({ sql: `INSERT INTO generations(id,kind,provider,model,prompt,params,status,created_at,updated_at) VALUES(?,'image','google',?,'a still','{}','running',?,?)`, args: [id, model, feb - 100, feb - 100] });
      /* The reservation reads the clock in its last moments of January (its month and its own time); everything after it, the note
         included, reads it after midnight on the 1st, as a note sent off past the turn (or past the response) can. */
      const reservation = /reserveGenerationSpendLocked|billingTransaction/;
      Date.now = () => (reservation.test(new Error().stack ?? "") ? feb - 100 : feb + 100);
      await reserveGenerationSpend({ id, kind: "image" as const, engine: "google", model, status: "running" as const, engineCostUsd: usd });
      await houseNotesSettled();
      Date.now = clock;
      expect(Number((await platformDb().execute({ sql: "SELECT created_at FROM meter_events WHERE id=?", args: [id] })).rows[0].created_at)).toBe(feb - 100);
      expect(await lines(jan, feb)).toBe(1);
      expect(await lines(feb, mar)).toBe(0);
      /* February's own crossing still speaks, once. */
      expect(await noteHouseSpend(cap * 0.9, cap, feb + 100)).toBe(true);
      expect(await noteHouseSpend(cap * 0.9, cap, feb + 200)).toBe(false);
      expect(await lines(feb, mar)).toBe(1);
      expect(await lines(jan, feb)).toBe(1);
      /* Given the month its spend was summed over, a note that runs in the next one marks that month, dated inside it. */
      expect(await noteHouseSpend(cap * 0.9, cap, apr + 5, mar)).toBe(true);
      expect(await lines(mar, apr)).toBe(1);
      expect(await lines(apr, may)).toBe(0);
      /* The job ends with nothing charged, so this month's figure for the files after this one is as it was. */
      await meter({ id, kind: "image", engine: "google", model, status: "failed", engineCostUsd: 0 });
    });
  } finally {
    Date.now = clock;
    await platformDb().execute("UPDATE workspaces SET allowance_usd=NULL WHERE id='ws_legacy'");
  }
  expect(await houseSpendSince(houseMonthStart())).toBeCloseTo(before, 6);
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

test("GET /api/usage/house-cap: every workspace but the house reads null, whoever asks; the house reads its cap", async () => {
  const { runInTenant } = await import("../../lib/tenant");
  const auth = await import("../../lib/auth");
  await houseRow();
  type Handler = (req: Request) => Promise<Response>;
  const read = async (ws: TenantWorkspace, role: "admin" | "member") => {
    const user = { id: `u_house_cap_${role}`, email: `${role}@example.test`, name: role, role };
    const mod = loadRouteModule<{ GET: Handler }>("app/api/usage/house-cap/route.ts", {
      "@/lib/auth": { ...auth, withTenant: (fn: Handler) => (req: Request) => runInTenant(ws, () => fn(req), { user, workspaces: [{ id: ws.id, slug: ws.slug, name: ws.name, role }] } as never) },
    });
    const res = await mod.GET(new Request("https://studio.test/api/usage/house-cap"));
    return { status: res.status, body: await res.json() };
  };
  for (const ws of [customer(), { ...customer(), id: "ws_house_cap_own_keys", usesPlatformKeys: false } as TenantWorkspace])
    for (const role of ["admin", "member"] as const) expect(await read(ws, role), `${ws.id} ${role}`).toEqual({ status: 200, body: { houseCap: null } });
  expect(await read(house(), "member")).toMatchObject({ status: 200, body: { houseCap: { capUsd: 500, source: "default" } } });
});

test("/admin shows the new standing: after a raise and after a lowering the desk reads the cap in force and the month's spend and share against it, and nobody is warned", async () => {
  const { runInTenant } = await import("../../lib/tenant");
  const { db, ready } = await import("../../lib/db");
  const { platformDb, platformReady, setHouseCap } = await import("../../lib/platform");
  const { reserveGenerationSpend } = await import("../../lib/generationRequests");
  const { houseNotesSettled, houseSpendSince, houseMonthStart } = await import("../../lib/houseCap");
  const { houseCapStanding, houseCapState, houseCapUsdText } = await import("../../lib/houseCapText");
  const { meter } = await import("../../lib/meter");
  await platformReady();
  await houseRow();
  /* The desk's own read (GET /api/admin/invites, which /admin and the platform console poll), with its real platform-owner guard. */
  type Handler = () => Promise<Response>;
  const desk = loadRouteModule<{ GET: Handler }>("app/api/admin/invites/route.ts", { "@/lib/recovery": { recoveryRoute: (handler: Handler) => handler } });
  const owner = { id: "acct_house_cap_owner", email: "house-cap-owner@example.test", name: "Owner", role: "admin" as const };
  const read = async () => runInTenant(customer(), async () => {
    const res = await desk.GET();
    expect(res.status).toBe(200);
    const body = await res.json() as { workspaces: { id: string; houseCap: { capUsd: number; spentUsd: number; pct: number; warn: boolean; stop: boolean; source: string } | null }[] };
    return body.workspaces.find((w) => w.id === "ws_legacy")!.houseCap!;
  }, { user: owner } as never);
  const warned = async () => Number((await platformDb().execute({ sql: "SELECT COUNT(*) AS n FROM platform_audit WHERE action='housecap.warned' AND created_at>=?", args: [houseMonthStart()] })).rows[0].n);
  const model = "gemini-3.1-flash-image";
  const id = `gen_housecap_desk_${Date.now().toString(36)}`;
  const before = await houseSpendSince(houseMonthStart());
  try {
    await runInTenant(house(), async () => {
      await ready();
      /* Something spent this month, so the standing has a figure to show: a synthetic $1 job, ended at nothing charged below. */
      await setHouseCap(before + 100, "acct_house_cap_owner");
      await db().execute({ sql: `INSERT INTO generations(id,kind,provider,model,prompt,params,status,created_at,updated_at) VALUES(?,'image','google',?,'a still','{}','running',?,?)`, args: [id, model, Date.now(), Date.now()] });
      await reserveGenerationSpend({ id, kind: "image" as const, engine: "google", model, status: "running" as const, engineCostUsd: 1 });
      await houseNotesSettled();
    });
    const spent = await houseSpendSince(houseMonthStart());
    expect(spent).toBeGreaterThanOrEqual(1);
    const lines = await warned();
    const standing = (cap: number) => houseCapStanding(houseCapState(cap, spent));
    const spentText = houseCapUsdText(Math.round(spent * 100) / 100);

    /* Raised: the new figure, and the month's spend and share against it. */
    const raised = Math.ceil(spent * 4 + 50);
    await setHouseCap(raised, "acct_house_cap_owner");
    const up = await read();
    expect(up).toMatchObject({ capUsd: raised, source: "own", warn: false, stop: false, pct: Math.floor((spent / raised) * 100 + 1e-9) });
    expect(up.spentUsd).toBeCloseTo(spent, 9);
    expect(houseCapStanding(up)).toBe(standing(raised));
    expect(houseCapStanding(up)).toBe(`${spentText} of ${houseCapUsdText(raised)} used · ${up.pct}%`);

    /* Lowered into the warning band: the new figure and where the month now stands against it, at once; nobody is told. */
    const banded = Math.round((spent / 0.9) * 100) / 100;
    await setHouseCap(banded, "acct_house_cap_owner");
    const warn = await read();
    expect(warn).toMatchObject({ capUsd: banded, warn: true, stop: false });
    expect(houseCapStanding(warn)).toBe(standing(banded));
    expect(houseCapStanding(warn)).toMatch(new RegExp(`^${warn.pct}% of this month's \\${houseCapUsdText(banded)} used \\(\\$`));

    /* Lowered under the month's spend: reached, with the spend and the share still shown. */
    const under = Math.floor((spent / 2) * 100) / 100;
    await setHouseCap(under, "acct_house_cap_owner");
    const stop = await read();
    expect(stop).toMatchObject({ capUsd: under, warn: true, stop: true, pct: 100 });
    expect(houseCapStanding(stop)).toBe(`Reached · ${spentText} of ${houseCapUsdText(under)} used · 100%`);
    /* Setting the cap, either way, warns nobody (the warning is the reservation's alone). */
    expect(await warned()).toBe(lines);

    /* /admin's cap cell and the platform console's sheet both show that line, read-only, under the cap's figure. */
    const page = readFileSync("app/(app)/admin/page.tsx", "utf8");
    const cell = page.slice(page.indexOf("function CapCell("), page.indexOf("type Queue = {"));
    expect(cell).toContain("{ main: houseCapUsdText(houseCap.capUsd), sub: houseCapStanding(houseCap),");
    expect(readFileSync("components/v12/platform/Workspaces.tsx", "utf8")).toContain("<strong>{houseCapStanding(data.houseCap)}</strong>");
    expect(readFileSync("app/api/admin/invites/route.ts", "utf8")).toContain("await houseCapViewFor(houseRow.allowance_usd)");
  } finally {
    await runInTenant(house(), async () => { await meter({ id, kind: "image", engine: "google", model, status: "failed", engineCostUsd: 0 }); });
    await platformDb().execute("UPDATE workspaces SET allowance_usd=NULL WHERE id='ws_legacy'");
  }
  expect(await houseSpendSince(houseMonthStart())).toBeCloseTo(before, 6);
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
