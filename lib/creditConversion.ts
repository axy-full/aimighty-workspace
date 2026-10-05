import type { Transaction } from "@libsql/client";
import { billingReady, billingTransaction, syncBillingLedger } from "./billingLedger";
import { platformDb, platformReady, getWorkspace } from "./platform";
import { creditRateUsd, creditUsd } from "./creditTerms";
import { HOUSE_WORKSPACE_ID } from "./houseWorkspace";
import { ledgerUnitTx, samePrice, setLedgerUnitTx } from "./ledgerUnit";
import { convertTenantFigures, type TenantFigure } from "./creditConversionTenant";

/**
 * Restating the credit record in a new price of a credit.
 *
 * Owner's decision, 5 October 2026: one credit goes back to US$0.10. particl.si
 * has run with CREDIT_USD=0.80 since its production build of 3 October 2026
 * (14:39 UTC), and nothing was converted when it moved, so its record is in
 * two units: what was written before that build counts in US$0.10 credits,
 * what was written after in US$0.80 credits. A credit at US$0.80 is exactly
 * eight at US$0.10.
 *
 * Two ways to state it, chosen explicitly by whoever runs it, both shown side
 * by side in a dry run:
 *
 *  - `per-row` (with `cutoverAt`): each row is multiplied by the factor of the
 *    unit it was written in, 8 for a US$0.80 row and 1 for a US$0.10 row.
 *    Exact: every workspace ends with the dollars it actually paid for and was
 *    given. A job's unit is the price recorded on it (`meter_events.credit_usd`,
 *    NULL meaning US$0.10, lib/billingTerms.ts); a pack request's is its own
 *    dollars per credit; a grant made from a pack request follows the request;
 *    everything else (grants, lots, plan periods) follows its time against
 *    `cutoverAt`. Allocations follow their job, so a US$0.10 lot drawn by
 *    US$0.80 jobs ends overdrawn by the difference, which is a debt.
 *  - `uniform`: every row × 8. Keeps what every balance reads today on
 *    particl.si, including the eightfold value credits written before 3 October
 *    gained when the price moved under them.
 *
 * Every credit figure is multiplied by its row's factor and every recorded
 * price of a credit divided by it, so credits × price, a job's dollars, never
 * moves. Factors are powers of two, so a reversal divides back to the very
 * numbers it started from. Dollars stored as dollars (what a pack cost, an
 * invoice, an engine's cost) are never touched.
 *
 * Per workspace, in ONE platform write: credit_grants, billing_lots (credits;
 * drawn by the allocations that drew it; kind, expiry and clocks untouched, so
 * purchased stays purchased, included stays included and each lot keeps its
 * expiry), billing_debits (receipts, reservations of running jobs, debt),
 * billing_allocations, billing_refunds, billing_cycles,
 * billing_paid_periods.included_credits, topup_requests (credits and bonus,
 * open ones included), meter_events (billed_credits, and credit_usd the other
 * way), the account database's pending workspace_provisioning welcome; each
 * changed row listed in billing_unit_conversion_rows; and one row in
 * billing_unit_conversions with the balance before and after. Then the
 * workspace's own database (lib/creditConversionTenant.ts), marked done on
 * that row. When every workspace states the new unit, the ledger's unit moves
 * (lib/ledgerUnit.ts) and paid jobs resume.
 *
 * Idempotent: a workspace whose last row states the target price is reported
 * `already`, and an unfinished workspace half is finished. Reversible: a
 * reversal is its own row, the recorded factors inverted. Never on the house
 * workspace, which is not billed in credits.
 */

export const CONVERSIONS_TABLE = "billing_unit_conversions";
export const CONVERSION_ROWS_TABLE = "billing_unit_conversion_rows";
export type ConversionMode = "per-row" | "uniform";
export { samePrice };

export type BalanceSnapshot = {
  /** The price the snapshot's dollars are read at: what the screens show at that moment. */
  unitUsd: number;
  balance: number;
  balanceUsd: number;
  included: number;
  purchased: number;
  bonus: number;
  other: number;
  /** Credits charged that no lot covered: a debt, already subtracted from the balance. */
  debt: number;
  /** Credits reserved by jobs still running, and how many. */
  reserved: number;
  running: number;
  /** Credits on open pack requests (bought, not yet granted). */
  pendingPacks: number;
  /** Every lot with credits left: its kind, what is left, and when it expires. */
  lots: { id: string; kind: string; remaining: number; expiresAt: number | null }[];
};

export type ConversionStatus = "planned" | "converted" | "reversed" | "already" | "refused" | "house" | "nothing" | "needs-decision";
/** What the owner decided for a workspace whose balance the conversion would lower: write the shortfall off, or apply it. */
export type ShortfallDecision = "goodwill" | "apply";
/** Marked, never excluded: so the owner can read the dry run. */
export type WorkspaceMarks = { house: boolean; internal: boolean; platformOwner: boolean; test: boolean; name: string; ownerEmail: string | null };
export type CreditConversion = {
  id: string | null;
  workspaceId: string;
  status: ConversionStatus;
  action: "convert" | "reverse";
  mode: ConversionMode | null;
  fromUsd: number;
  toUsd: number;
  before: BalanceSnapshot | null;
  after: BalanceSnapshot | null;
  /** Platform rows changed, by table, and how many of them were multiplied by more than one. */
  rows: Record<string, number>;
  tenant: TenantFigure[];
  tenantDone: boolean;
  marks?: WorkspaceMarks;
  /**
   * Credits (in the new unit) a US$0.80 job took from credits given at US$0.10: what the exact
   * conversion takes off this balance, and its dollars. Above zero, a real run needs a decision.
   */
  shortfall?: number;
  shortfallUsd?: number;
  /** The balance falls (in credits) or ends below zero because of it. */
  goesDown?: boolean;
  belowZero?: boolean;
  /** The balance if the shortfall is written off as goodwill. */
  balanceWithGoodwill?: number;
  decision?: ShortfallDecision | null;
  goodwillGrantId?: string | null;
  /** Pack requests still open at the old price: declined, not converted. */
  declinedTopups?: { id: string; credits: number; usd: number }[];
  reason?: string;
};

export const TOPUP_DECLINED_NOTE = "Price changed; please ask again at US$0.10.";

async function marksOf(workspaceId: string): Promise<WorkspaceMarks> {
  const r = (await platformDb().execute({
    sql: `SELECT w.name, w.internal_test, a.email FROM workspaces w LEFT JOIN accounts a ON a.id=w.owner_id WHERE w.id=?`, args: [workspaceId],
  })).rows[0];
  const email = r?.email == null ? null : String(r.email).toLowerCase();
  const name = String(r?.name ?? workspaceId);
  const owner = (process.env.SUPER_ADMIN_EMAIL ?? "").trim().toLowerCase();
  return {
    house: workspaceId === HOUSE_WORKSPACE_ID,
    internal: Number(r?.internal_test ?? 0) === 1,
    platformOwner: Boolean(owner && email === owner),
    test: /@example\.(test|com)$/.test(email ?? "") || /test|fixture|e2e/i.test(name) || /test|fixture|e2e/i.test(workspaceId),
    name, ownerEmail: email,
  };
}

/** The exact integer factor between two prices of a credit, or null when there is none. */
export function unitFactor(fromUsd: number, toUsd: number): number | null {
  if (!(fromUsd > 0) || !(toUsd > 0) || !Number.isFinite(fromUsd) || !Number.isFinite(toUsd)) return null;
  const k = Math.round(fromUsd / toUsd);
  if (k < 2) return null;
  return Math.round(fromUsd * 1e6) === k * Math.round(toUsd * 1e6) ? k : null;
}

const dollars = (usd: number) => `US$${creditRateUsd(usd) ?? usd}`;
const money = (n: number) => Math.round(n * 1e6) / 1e6;

let tableReady: Promise<void> | undefined;
export async function conversionsReady(): Promise<void> {
  tableReady ??= (async () => {
    await billingReady();
    await platformDb().batch([
      `CREATE TABLE IF NOT EXISTS ${CONVERSIONS_TABLE}(id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, action TEXT NOT NULL,
        mode TEXT, cutover_at INTEGER, from_usd REAL NOT NULL, to_usd REAL NOT NULL, reverses TEXT,
        balance_before REAL, balance_after REAL, usd_before REAL, usd_after REAL,
        before_json TEXT NOT NULL, after_json TEXT NOT NULL, rows_json TEXT, tenant_json TEXT, tenant_applied_at INTEGER,
        created_by TEXT, created_at INTEGER NOT NULL)`,
      `CREATE INDEX IF NOT EXISTS ${CONVERSIONS_TABLE}_ws ON ${CONVERSIONS_TABLE}(workspace_id, created_at)`,
      `CREATE TABLE IF NOT EXISTS ${CONVERSION_ROWS_TABLE}(conversion_id TEXT NOT NULL, tbl TEXT NOT NULL, row_key TEXT NOT NULL,
        factor REAL NOT NULL, PRIMARY KEY(conversion_id, tbl, row_key))`,
    ], "write");
  })().catch((error) => { tableReady = undefined; throw error; });
  await tableReady;
}

async function snapshotTx(tx: Transaction, workspaceId: string, at: number, unitUsd: number): Promise<BalanceSnapshot> {
  const lots = (await tx.execute({
    sql: `SELECT id,kind,credits,drawn,expires_at FROM billing_lots WHERE workspace_id=? ORDER BY created_at,id`,
    args: [workspaceId],
  })).rows;
  let balance = 0;
  const byKind: Record<string, number> = {};
  const live: BalanceSnapshot["lots"] = [];
  for (const r of lots) {
    const credits = Number(r.credits), drawn = Number(r.drawn);
    const expiresAt = r.expires_at == null ? null : Number(r.expires_at);
    const active = expiresAt == null || expiresAt > at;
    // As the ledger reads it (billingLedger balanceTx): an overdrawn lot always counts; an expired one counts nothing.
    balance += credits < drawn ? credits - drawn : active ? credits - drawn : 0;
    if (active || credits < drawn) byKind[String(r.kind)] = (byKind[String(r.kind)] ?? 0) + (credits < drawn || active ? credits - drawn : 0);
    if (active && credits - drawn > 0) live.push({ id: String(r.id), kind: String(r.kind), remaining: credits - drawn, expiresAt });
  }
  const debtRow = (await tx.execute({
    sql: `SELECT COALESCE((SELECT SUM(credits) FROM billing_debits WHERE workspace_id=?),0)-COALESCE((SELECT SUM(credits) FROM billing_allocations WHERE workspace_id=?),0) AS n`,
    args: [workspaceId, workspaceId],
  })).rows[0];
  const debt = Number(debtRow?.n ?? 0);
  balance -= debt;
  const running = (await tx.execute({
    sql: `SELECT COUNT(*) AS n, COALESCE(SUM(d.credits),0) AS c FROM meter_events m JOIN billing_debits d ON d.workspace_id=m.workspace_id AND d.event_id=m.id
      WHERE m.workspace_id=? AND m.status='running'`,
    args: [workspaceId],
  })).rows[0];
  const pending = (await tx.execute({
    sql: `SELECT COALESCE(SUM(credits+COALESCE(bonus_credits,0)),0) AS c FROM topup_requests WHERE workspace_id=? AND status='requested'`,
    args: [workspaceId],
  })).rows[0];
  const included = byKind.included ?? 0, purchased = byKind.purchase ?? 0, bonus = byKind.bonus ?? 0;
  return {
    unitUsd, balance: money(balance), balanceUsd: money(balance * unitUsd),
    included: money(included), purchased: money(purchased), bonus: money(bonus), other: money(balance - included - purchased - bonus),
    debt: money(debt), reserved: money(Number(running?.c ?? 0)), running: Number(running?.n ?? 0),
    pendingPacks: money(Number(pending?.c ?? 0)), lots: live,
  };
}

type Plan = { mode: ConversionMode; k: number; fromUsd: number; cutoverAt: number | null };
type RowFactor = { tbl: string; key: string; factor: number };

/** Which platform rows of a workspace change, and by how much. */
type Factors = { rows: RowFactor[]; shortfall: number; declines: { id: string; credits: number; usd: number }[] };
async function factorsTx(tx: Transaction, workspaceId: string, p: Plan): Promise<Factors> {
  const byTime = (ts: unknown) => (p.mode === "uniform" ? p.k : Number(ts) >= (p.cutoverAt ?? Infinity) ? p.k : 1);
  const out: RowFactor[] = [];
  const add = (tbl: string, key: string, factor: number) => { if (factor !== 1) out.push({ tbl, key, factor }); };
  const rows = async (sql: string) => (await tx.execute({ sql, args: [workspaceId] })).rows;

  const requests = new Map<string, number>();
  const declines: Factors["declines"] = [];
  for (const r of await rows(`SELECT id,credits,bonus_credits,usd,status FROM topup_requests WHERE workspace_id=?`)) {
    const credits = Number(r.credits), usd = Number(r.usd);
    // A pack request carries its own unit: the dollars it was priced at for its credits.
    const f = p.mode === "uniform" ? p.k : credits > 0 && Math.abs(usd - credits * p.fromUsd) < 0.005 ? p.k : 1;
    requests.set(String(r.id), f);
    /* Still open at the old price: no money was taken at it, so it is declined, not converted (owner, 5 October 2026). */
    if (r.status === "requested" && f !== 1) { declines.push({ id: String(r.id), credits: credits + Number(r.bonus_credits ?? 0), usd }); continue; }
    add("topup_requests", String(r.id), f);
  }
  const lotFactor = new Map<string, number>();
  for (const r of await rows(`SELECT id,created_at FROM billing_lots WHERE workspace_id=?`)) {
    const id = String(r.id);
    const topup = /^topup:([^:]+):/.exec(id);
    const f = topup && requests.has(topup[1]) ? requests.get(topup[1])! : byTime(r.created_at);
    lotFactor.set(id, f);
    add("billing_lots", id, f);
  }
  for (const r of await rows(`SELECT id,created_at FROM credit_grants WHERE workspace_id=?`))
    add("credit_grants", String(r.id), lotFactor.get(String(r.id)) ?? byTime(r.created_at));
  const eventFactor = new Map<string, number>();
  for (const r of await rows(`SELECT id,credit_usd FROM meter_events WHERE workspace_id=?`)) {
    const unit = Number(r.credit_usd) > 0 ? Number(r.credit_usd) : 0.10;
    const f = p.mode === "uniform" ? p.k : samePrice(unit, p.fromUsd) ? p.k : 1;
    eventFactor.set(String(r.id), f);
    add("meter_events", String(r.id), f);
  }
  const debitFactor = new Map<string, number>();
  for (const r of await rows(`SELECT event_id,created_at FROM billing_debits WHERE workspace_id=?`)) {
    const f = eventFactor.get(String(r.event_id)) ?? byTime(r.created_at);
    debitFactor.set(String(r.event_id), f);
    add("billing_debits", String(r.event_id), f);
  }
  /* A job at the new-old price drawing a lot written in the old-old one (a US$0.80 job spending credits
     given at US$0.10) costs more of that lot once both are in one unit: that is the shortfall. */
  let shortfall = 0;
  for (const r of await rows(`SELECT event_id,lot_id,credits FROM billing_allocations WHERE workspace_id=?`)) {
    const f = debitFactor.get(String(r.event_id)) ?? 1;
    shortfall += Number(r.credits) * Math.max(0, f - (lotFactor.get(String(r.lot_id)) ?? 1));
    add("billing_allocations", JSON.stringify([String(r.event_id), String(r.lot_id)]), f);
  }
  for (const r of await rows(`SELECT id,source_id,created_at FROM billing_refunds WHERE workspace_id=?`))
    add("billing_refunds", String(r.id), lotFactor.get(String(r.source_id)) ?? byTime(r.created_at));
  for (const r of await rows(`SELECT id,grant_id,starts_at FROM billing_cycles WHERE workspace_id=?`))
    add("billing_cycles", String(r.id), lotFactor.get(String(r.grant_id)) ?? byTime(r.starts_at));
  for (const r of await rows(`SELECT invoice_id,created_at FROM billing_paid_periods WHERE workspace_id=?`))
    add("billing_paid_periods", String(r.invoice_id), byTime(r.created_at));
  if ((await tx.execute(`SELECT 1 FROM sqlite_master WHERE type='table' AND name='workspace_provisioning'`)).rows.length)
    for (const r of await rows(`SELECT workspace_id,created_at FROM workspace_provisioning WHERE workspace_id=? AND welcome_credits<>0`))
      add("workspace_provisioning", String(r.workspace_id), byTime(r.created_at));
  return { rows: out, shortfall: money(shortfall), declines };
}

/** Simple tables: one key column, the credit columns multiplied, a price column divided. */
const SIMPLE: Record<string, { key: string; mul: string[]; div?: string[] }> = {
  credit_grants: { key: "id", mul: ["credits"] },
  topup_requests: { key: "id", mul: ["credits", "bonus_credits"] },
  // The price a job was approved at (credit_usd) is NOT rewritten: it is what the job was approved in,
  // and settlement counts it in the ledger's unit (lib/ledgerUnit.ts restateFactor), so a job settling
  // after the conversion is booked ×8 once, never twice.
  meter_events: { key: "id", mul: ["billed_credits"] },
  billing_debits: { key: "event_id", mul: ["credits"] },
  billing_refunds: { key: "id", mul: ["credits"] },
  billing_cycles: { key: "id", mul: ["credits"] },
  billing_paid_periods: { key: "invoice_id", mul: ["included_credits"] },
  workspace_provisioning: { key: "workspace_id", mul: ["welcome_credits"] },
};

/** Apply row factors. Allocations first: a lot's `drawn` moves by exactly what its allocations moved. */
async function applyTx(tx: Transaction, workspaceId: string, factors: RowFactor[]): Promise<void> {
  const drawn = new Map<string, number>();
  for (const f of factors.filter((x) => x.tbl === "billing_allocations")) {
    const [eventId, lotId] = JSON.parse(f.key) as [string, string];
    const row = (await tx.execute({
      sql: `SELECT credits FROM billing_allocations WHERE workspace_id=? AND event_id=? AND lot_id=?`, args: [workspaceId, eventId, lotId],
    })).rows[0];
    if (!row) continue;
    const before = Number(row.credits);
    await tx.execute({
      sql: `UPDATE billing_allocations SET credits=credits*? WHERE workspace_id=? AND event_id=? AND lot_id=?`, args: [f.factor, workspaceId, eventId, lotId],
    });
    drawn.set(lotId, (drawn.get(lotId) ?? 0) + before * f.factor - before);
  }
  const lotFactors = new Map(factors.filter((x) => x.tbl === "billing_lots").map((x) => [x.key, x.factor]));
  for (const id of new Set([...lotFactors.keys(), ...drawn.keys()]))
    await tx.execute({
      sql: `UPDATE billing_lots SET credits=credits*?, drawn=drawn+? WHERE workspace_id=? AND id=?`,
      args: [lotFactors.get(id) ?? 1, drawn.get(id) ?? 0, workspaceId, id],
    });
  /* A goodwill grant taken back by a reversal: its credits go, what was spent from it stays spent (a debt). */
  for (const f of factors.filter((x) => x.tbl === "goodwill"))
    for (const table of ["credit_grants", "billing_lots"])
      await tx.execute({ sql: `UPDATE ${table} SET credits=0 WHERE workspace_id=? AND id=?`, args: [workspaceId, f.key] });
  for (const f of factors) {
    const t = SIMPLE[f.tbl];
    if (!t) continue;
    const sets = [...t.mul.map((c) => `${c}=${c}*?1`), ...(t.div ?? []).map((c) => `${c}=${c}/?1`)].join(",");
    await tx.execute({ sql: `UPDATE ${f.tbl} SET ${sets} WHERE workspace_id=?2 AND ${t.key}=?3`, args: [f.factor, workspaceId, f.key] });
  }
}

const countRows = (factors: RowFactor[]) => factors.reduce<Record<string, number>>((a, f) => ({ ...a, [f.tbl]: (a[f.tbl] ?? 0) + 1 }), {});

class DryRun extends Error {
  constructor(readonly result: CreditConversion) { super("dry run"); }
}

type Options = { by?: string | null; dryRun?: boolean; at?: number };

function houseLine(workspaceId: string, action: "convert" | "reverse", mode: ConversionMode | null, fromUsd: number, toUsd: number): CreditConversion {
  return {
    id: null, workspaceId, status: "house", action, mode, fromUsd, toUsd, before: null, after: null, rows: {}, tenant: [], tenantDone: true,
    reason: "The house workspace is never billed in credits: it has no balance to restate.",
  };
}

async function lastRowTx(tx: Pick<Transaction, "execute">, workspaceId: string): Promise<{ row: Record<string, unknown> | null; count: number }> {
  const rs = await tx.execute({ sql: `SELECT * FROM ${CONVERSIONS_TABLE} WHERE workspace_id=? ORDER BY created_at, rowid`, args: [workspaceId] });
  return { row: (rs.rows.at(-1) as Record<string, unknown> | undefined) ?? null, count: rs.rows.length };
}

function tenantFactorAt(p: Plan): (ts: number | null) => number {
  return (ts) => (p.mode === "uniform" ? p.k : ts != null && ts >= (p.cutoverAt ?? Infinity) ? p.k : 1);
}

/** Finish the workspace-database half of a recorded row, once. */
async function finishTenant(workspaceId: string, row: Record<string, unknown>, at: number): Promise<TenantFigure[]> {
  if (row.tenant_applied_at != null) return JSON.parse(String(row.tenant_json ?? "[]")) as TenantFigure[];
  const ws = await getWorkspace(workspaceId);
  const plan: Plan = { mode: (row.mode as ConversionMode) ?? "uniform", k: Number(row.from_usd) / Number(row.to_usd), fromUsd: Number(row.from_usd), cutoverAt: row.cutover_at == null ? null : Number(row.cutover_at) };
  const figures = ws
    ? await convertTenantFigures(ws, { factorAt: tenantFactorAt(plan), conversionId: String(row.id), dryRun: false, reverses: row.reverses == null ? null : String(row.reverses) })
    : [];
  await platformDb().execute({
    sql: `UPDATE ${CONVERSIONS_TABLE} SET tenant_json=?, tenant_applied_at=? WHERE id=? AND tenant_applied_at IS NULL`,
    args: [JSON.stringify(figures), at, String(row.id)],
  });
  return figures;
}

/**
 * One workspace from `fromUsd` to `toUsd` credits. With `dryRun`, the same
 * figures inside a write that is rolled back, and nothing written anywhere.
 */
export async function convertWorkspaceCredits(
  workspaceId: string,
  o: Options & { fromUsd: number; toUsd: number; mode: ConversionMode; cutoverAt?: number | null; decision?: ShortfallDecision | null },
): Promise<CreditConversion> {
  if (!o.dryRun && o.mode !== "per-row") throw new Error("A real run is per row (owner, 5 October 2026); uniform is a dry-run comparison only.");
  const k = unitFactor(o.fromUsd, o.toUsd);
  if (k == null) throw new Error(`${dollars(o.fromUsd)} is not a whole number of ${dollars(o.toUsd)} credits.`);
  if (o.mode === "per-row" && !(Number(o.cutoverAt) > 0)) throw new Error("A per-row conversion needs cutoverAt: when the price moved.");
  if (workspaceId === HOUSE_WORKSPACE_ID) return houseLine(workspaceId, "convert", o.mode, o.fromUsd, o.toUsd);
  await conversionsReady();
  const at = o.at ?? Date.now();
  const plan: Plan = { mode: o.mode, k, fromUsd: o.fromUsd, cutoverAt: o.mode === "per-row" ? Number(o.cutoverAt) : null };
  let result: CreditConversion;
  try {
    result = await billingTransaction(async (tx) => {
      await syncBillingLedger(tx, workspaceId, at);
      const { row: last, count } = await lastRowTx(tx, workspaceId);
      const base = { workspaceId, action: "convert" as const, mode: o.mode, fromUsd: o.fromUsd, toUsd: o.toUsd, rows: {}, tenant: [] as TenantFigure[], tenantDone: false };
      if (last && samePrice(Number(last.to_usd), o.toUsd)) {
        const now = await snapshotTx(tx, workspaceId, at, o.toUsd);
        return { ...base, id: String(last.id), mode: (last.mode as ConversionMode) ?? null, status: "already" as const, before: now, after: now,
          tenantDone: last.tenant_applied_at != null, reason: `Already stated in ${dollars(o.toUsd)} credits.` };
      }
      const stated = last ? Number(last.to_usd) : o.fromUsd;
      if (!samePrice(stated, o.fromUsd))
        return { ...base, id: null, status: "refused" as const, before: null, after: null, reason: `This workspace is stated in ${dollars(stated)} credits, not ${dollars(o.fromUsd)}.` };
      const before = await snapshotTx(tx, workspaceId, at, o.fromUsd);
      const plan2 = await factorsTx(tx, workspaceId, plan);
      const factors = plan2.rows;
      await applyTx(tx, workspaceId, factors);
      const id = `unit:${workspaceId}:${count + 1}`;
      for (const d of plan2.declines)
        await tx.execute({
          sql: `UPDATE topup_requests SET status='declined',decided_at=?,decided_by=?,decision_note=? WHERE id=? AND workspace_id=? AND status='requested'`,
          args: [at, o.by ?? null, TOPUP_DECLINED_NOTE, d.id, workspaceId],
        });
      const exact = await snapshotTx(tx, workspaceId, at, o.toUsd);
      const shortfall = plan2.shortfall;
      const goesDown = shortfall > 0 && exact.balance < before.balance;
      const belowZero = shortfall > 0 && exact.balance < 0 && before.balance >= 0;
      const facts = {
        shortfall, shortfallUsd: money(shortfall * o.toUsd), goesDown, belowZero,
        balanceWithGoodwill: money(exact.balance + shortfall), declinedTopups: plan2.declines,
        decision: shortfall > 0 ? (o.decision ?? null) : null,
      };
      let goodwillGrantId: string | null = null;
      if (shortfall > 0 && o.decision === "goodwill") {
        /* Written off: a recorded grant, so the balance ends where the customer saw it heading. */
        goodwillGrantId = `${id}:goodwill`;
        await tx.execute({
          sql: `INSERT INTO credit_grants(id,workspace_id,credits,note,kind,created_by,created_at) VALUES(?,?,?,?,'manual',?,?)`,
          args: [goodwillGrantId, workspaceId, shortfall, `Goodwill: US$0.10 credits spent at US$0.80 prices, ${dollars(shortfall * o.toUsd)}`, o.by ?? null, at],
        });
        await syncBillingLedger(tx, workspaceId, at);
        factors.push({ tbl: "goodwill", key: goodwillGrantId, factor: 1 });
      }
      const after = await snapshotTx(tx, workspaceId, at, o.toUsd);
      const out: CreditConversion = { ...base, id, status: "converted", before, after, rows: countRows(factors), ...facts, goodwillGrantId };
      if (o.dryRun) throw new DryRun({ ...out, status: shortfall > 0 && !o.decision ? "needs-decision" : "planned" });
      /* A balance this lowers is never converted half-way: no decision, nothing written for it. */
      if (shortfall > 0 && !o.decision) throw new DryRun({ ...out, id: null, status: "needs-decision",
        reason: `Its US$0.80 jobs spent ${dollars(shortfall * o.toUsd)} of credits given at US$0.10. Decide goodwill or apply.` });
      await tx.execute({
        sql: `INSERT INTO ${CONVERSIONS_TABLE}(id,workspace_id,action,mode,cutover_at,from_usd,to_usd,reverses,balance_before,balance_after,usd_before,usd_after,before_json,after_json,rows_json,created_by,created_at)
          VALUES(?,?,'convert',?,?,?,?,NULL,?,?,?,?,?,?,?,?,?)`,
        args: [id, workspaceId, o.mode, plan.cutoverAt, o.fromUsd, o.toUsd, before.balance, after.balance, before.balanceUsd, after.balanceUsd,
          JSON.stringify(before), JSON.stringify(after), JSON.stringify(out.rows), o.by ?? null, at],
      });
      for (const f of factors)
        await tx.execute({ sql: `INSERT INTO ${CONVERSION_ROWS_TABLE}(conversion_id,tbl,row_key,factor) VALUES(?,?,?,?)`, args: [id, f.tbl, f.key, f.factor] });
      return out;
    }, at);
  } catch (error) {
    if (!(error instanceof DryRun)) throw error;
    const ws = await getWorkspace(workspaceId);
    const tenant = ws ? await convertTenantFigures(ws, { factorAt: tenantFactorAt(plan), conversionId: "dry-run", dryRun: true }) : [];
    return { ...error.result, tenant, marks: await marksOf(workspaceId) };
  }
  result.marks = await marksOf(workspaceId);
  if (!o.dryRun && (result.status === "converted" || result.status === "already")) {
    const { row } = await lastRowTx(platformDb(), workspaceId);
    if (row) { result.tenant = await finishTenant(workspaceId, row, at); result.tenantDone = true; }
  }
  return result;
}

/** Undo a workspace's last conversion: its own row, the recorded factors inverted. */
export async function reverseWorkspaceCredits(workspaceId: string, o: Options = {}): Promise<CreditConversion> {
  if (workspaceId === HOUSE_WORKSPACE_ID) return houseLine(workspaceId, "reverse", null, 0, 0);
  await conversionsReady();
  const at = o.at ?? Date.now();
  let result: CreditConversion;
  try {
    result = await billingTransaction(async (tx) => {
      await syncBillingLedger(tx, workspaceId, at);
      const { row: last, count } = await lastRowTx(tx, workspaceId);
      if (!last || last.action !== "convert")
        return { id: null, workspaceId, status: "nothing" as const, action: "reverse" as const, mode: null, fromUsd: 0, toUsd: 0, before: null, after: null,
          rows: {}, tenant: [], tenantDone: true, reason: "There is no conversion to reverse: none was run, or the last one was already reversed." };
      const fromUsd = Number(last.to_usd), toUsd = Number(last.from_usd);
      const recorded = (await tx.execute({ sql: `SELECT tbl,row_key,factor FROM ${CONVERSION_ROWS_TABLE} WHERE conversion_id=?`, args: [String(last.id)] })).rows;
      const factors = recorded.map((r) => ({ tbl: String(r.tbl), key: String(r.row_key), factor: 1 / Number(r.factor) }));
      const before = await snapshotTx(tx, workspaceId, at, fromUsd);
      await applyTx(tx, workspaceId, factors);
      const after = await snapshotTx(tx, workspaceId, at, toUsd);
      const id = `unit:${workspaceId}:${count + 1}`;
      const out: CreditConversion = { id, workspaceId, status: "reversed", action: "reverse", mode: (last.mode as ConversionMode) ?? null, fromUsd, toUsd,
        before, after, rows: countRows(factors), tenant: [], tenantDone: false };
      if (o.dryRun) throw new DryRun({ ...out, status: "planned" });
      await tx.execute({
        sql: `INSERT INTO ${CONVERSIONS_TABLE}(id,workspace_id,action,mode,cutover_at,from_usd,to_usd,reverses,balance_before,balance_after,usd_before,usd_after,before_json,after_json,rows_json,created_by,created_at)
          VALUES(?,?,'reverse',?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        args: [id, workspaceId, last.mode == null ? null : String(last.mode), last.cutover_at == null ? null : Number(last.cutover_at), fromUsd, toUsd, String(last.id), before.balance, after.balance, before.balanceUsd, after.balanceUsd,
          JSON.stringify(before), JSON.stringify(after), JSON.stringify(out.rows), o.by ?? null, at],
      });
      return out;
    }, at);
  } catch (error) {
    if (!(error instanceof DryRun)) throw error;
    return error.result;
  }
  if (!o.dryRun && result.status === "reversed") {
    const { row } = await lastRowTx(platformDb(), workspaceId);
    if (row) { result.tenant = await finishTenant(workspaceId, row, at); result.tenantDone = true; }
  }
  return result;
}

/**
 * The platform layer's own credit figure: the cap a new production starts with
 * (`caps.defaultCapCredits`), restated like a workspace's, recorded under
 * PLATFORM_LAYER_ID. The welcome grant (`caps.signupCredits`) and the plans'
 * included credits are NOT restated: the owner set them for a US$0.10 credit
 * (250 welcome; 400 / 1,600 / 9,000 a month), and they are reported as kept.
 */
export const PLATFORM_LAYER_ID = "*platform-layer*";
export type LayerLine = { status: ConversionStatus; figures: TenantFigure[]; kept: TenantFigure[] };

async function convertLayer(o: Options & { plan: Plan | null; reverse: boolean; fromUsd: number; toUsd: number }, at: number): Promise<LayerLine> {
  await conversionsReady();
  return billingTransaction(async (tx) => {
    const { row: last, count } = await lastRowTx(tx, PLATFORM_LAYER_ID);
    const caps = (await tx.execute(`SELECT value,updated_at FROM platform_layer WHERE key='caps'`)).rows[0];
    const plans = (await tx.execute(`SELECT value FROM platform_layer WHERE key='plans'`)).rows[0];
    const kept: TenantFigure[] = [];
    let parsed: Record<string, unknown> = {};
    try { parsed = caps ? JSON.parse(String(caps.value)) : {}; } catch { parsed = {}; }
    if (typeof parsed.signupCredits === "number") kept.push({ what: "platform_layer.caps.signupCredits (kept)", id: "caps", before: parsed.signupCredits, after: parsed.signupCredits });
    try {
      for (const p of (plans ? JSON.parse(String(plans.value)) : []) as { id?: string; includedCredits?: number }[])
        if (typeof p?.includedCredits === "number") kept.push({ what: "platform_layer.plans.includedCredits (kept)", id: String(p.id), before: p.includedCredits, after: p.includedCredits });
    } catch { /* an unreadable row is the layer's defaults */ }
    let factor = 1;
    if (o.reverse) {
      if (!last || last.action !== "convert") return { status: "nothing" as const, figures: [], kept };
      const rec = (await tx.execute({ sql: `SELECT factor FROM ${CONVERSION_ROWS_TABLE} WHERE conversion_id=? AND tbl='platform_layer'`, args: [String(last.id)] })).rows[0];
      factor = rec ? 1 / Number(rec.factor) : 1;
    } else {
      if (last && samePrice(Number(last.to_usd), o.toUsd)) return { status: "already" as const, figures: [], kept };
      const p = o.plan!;
      factor = p.mode === "uniform" ? p.k : caps && Number(caps.updated_at) >= (p.cutoverAt ?? Infinity) ? p.k : 1;
    }
    const n = typeof parsed.defaultCapCredits === "number" ? parsed.defaultCapCredits : null;
    const figures: TenantFigure[] = n != null && factor !== 1 ? [{ what: "platform_layer.caps.defaultCapCredits", id: "caps", before: n, after: n * factor }] : [];
    if (o.dryRun) return { status: "planned" as const, figures, kept };
    if (figures.length)
      await tx.execute({ sql: `UPDATE platform_layer SET value=? WHERE key='caps'`, args: [JSON.stringify({ ...parsed, defaultCapCredits: n! * factor })] });
    const id = `unit:${PLATFORM_LAYER_ID}:${count + 1}`;
    const snap = JSON.stringify({ figures, kept });
    await tx.execute({
      sql: `INSERT INTO ${CONVERSIONS_TABLE}(id,workspace_id,action,mode,cutover_at,from_usd,to_usd,reverses,before_json,after_json,tenant_applied_at,created_by,created_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      args: [id, PLATFORM_LAYER_ID, o.reverse ? "reverse" : "convert", o.plan?.mode ?? (last?.mode == null ? null : String(last.mode)), o.plan?.cutoverAt ?? null,
        o.reverse ? Number(last!.to_usd) : o.fromUsd, o.reverse ? Number(last!.from_usd) : o.toUsd, o.reverse ? String(last!.id) : null, snap, snap, at, o.by ?? null, at],
    });
    if (figures.length && !o.reverse)
      await tx.execute({ sql: `INSERT INTO ${CONVERSION_ROWS_TABLE}(conversion_id,tbl,row_key,factor) VALUES(?,?,?,?)`, args: [id, "platform_layer", "caps.defaultCapCredits", factor] });
    return { status: (o.reverse ? "reversed" : "converted") as ConversionStatus, figures, kept };
  }, at);
}

/** Every workspace on the platform, deleted ones included: a restore must find its balance in the right unit. */
async function allWorkspaceIds(): Promise<string[]> {
  await platformReady();
  const rs = await platformDb().execute(`SELECT id FROM workspaces ORDER BY created_at, id`);
  return rs.rows.map((r) => String(r.id));
}

/**
 * The ledger's unit moves only when every workspace but the house states it and has its own
 * half in. Until then paid jobs stay paused (lib/ledgerUnit.ts); running the conversion again finishes it.
 */
async function settleLedgerUnit(target: number, by: string | null, at: number, universe?: string[]): Promise<{ moved: boolean; waiting: string[] }> {
  const waiting: string[] = [];
  for (const id of universe ?? (await allWorkspaceIds())) {
    if (id === HOUSE_WORKSPACE_ID) continue;
    const { row } = await lastRowTx(platformDb(), id);
    if (!row || !samePrice(Number(row.to_usd), target) || row.tenant_applied_at == null) waiting.push(id);
  }
  if (waiting.length) return { moved: false, waiting };
  await billingTransaction((tx) => setLedgerUnitTx(tx, target, by, at), at);
  return { moved: true, waiting };
}

export type ConversionRun = {
  dryRun: boolean;
  action: "convert" | "reverse";
  mode: ConversionMode | null;
  cutoverAt: number | null;
  fromUsd: number;
  toUsd: number;
  factor: number;
  ledgerUnitBefore: number | null;
  ledgerUnitAfter: number | null;
  /** Workspaces not yet in the target unit, which keep paid jobs paused. */
  waiting: string[];
  /** Listed apart: balances this lowers, each needing the owner's decision (goodwill or apply). */
  needsDecision: { workspaceId: string; name: string; shortfall: number; shortfallUsd: number; goesDown: boolean; belowZero: boolean;
    balanceBefore: number; balanceExact: number; balanceWithGoodwill: number; decision: ShortfallDecision | null; marks: WorkspaceMarks | undefined }[];
  /** Pack requests open at the old price: declined (dry run: to be declined), with the note they get. */
  declinedTopups: { workspaceId: string; id: string; credits: number; usd: number; note: string }[];
  layer: LayerLine | null;
  results: CreditConversion[];
  totals: { workspaces: number; changed: number; balanceBefore: number; balanceAfter: number; usdBefore: number; usdAfter: number };
};

function decisionsOf(results: CreditConversion[]): ConversionRun["needsDecision"] {
  return results.filter((r) => (r.shortfall ?? 0) > 0).map((r) => ({
    workspaceId: r.workspaceId, name: r.marks?.name ?? r.workspaceId, shortfall: r.shortfall!, shortfallUsd: r.shortfallUsd!,
    goesDown: Boolean(r.goesDown), belowZero: Boolean(r.belowZero), balanceBefore: r.before?.balance ?? 0,
    balanceExact: r.decision === "goodwill" ? money((r.after?.balance ?? 0) - r.shortfall!) : r.after?.balance ?? 0,
    balanceWithGoodwill: r.balanceWithGoodwill ?? 0, decision: r.decision ?? null, marks: r.marks,
  }));
}
const declinesOf = (results: CreditConversion[]): ConversionRun["declinedTopups"] =>
  results.flatMap((r) => (r.declinedTopups ?? []).map((d) => ({ workspaceId: r.workspaceId, ...d, note: TOPUP_DECLINED_NOTE })));

function totals(results: CreditConversion[]): ConversionRun["totals"] {
  const changed = results.filter((r) => r.status === "planned" || r.status === "converted" || r.status === "reversed");
  const sum = (f: (r: CreditConversion) => number) => money(changed.reduce((a, r) => a + f(r), 0));
  return {
    workspaces: results.length, changed: changed.length,
    balanceBefore: sum((r) => r.before?.balance ?? 0), balanceAfter: sum((r) => r.after?.balance ?? 0),
    usdBefore: sum((r) => r.before?.balanceUsd ?? 0), usdAfter: sum((r) => r.after?.balanceUsd ?? 0),
  };
}

const ledgerUnitNow = async () => { await billingReady(); return ledgerUnitTx(platformDb()); };

/**
 * The run the platform owner starts (app/api/admin/credit-unit). For real, it
 * needs paid jobs paused, which is what a ledger unit that differs from
 * CREDIT_USD already is: the record must still count in `fromUsd`.
 */
export async function convertAllCredits(
  o: Options & { fromUsd: number; toUsd: number; mode: ConversionMode; cutoverAt?: number | null; workspaceId?: string | null;
    decisions?: Record<string, ShortfallDecision>;
    /** The workspaces that make up the platform (default: every row of `workspaces`). Tests only. */
    universe?: string[] },
): Promise<ConversionRun> {
  if (!o.dryRun && o.mode !== "per-row") throw new Error("A real run is per row (owner, 5 October 2026); uniform is a dry-run comparison only.");
  const k = unitFactor(o.fromUsd, o.toUsd);
  if (k == null) throw new Error(`${dollars(o.fromUsd)} is not a whole number of ${dollars(o.toUsd)} credits.`);
  const unitBefore = await ledgerUnitNow();
  const at = o.at ?? Date.now();
  if (!o.dryRun && unitBefore != null && !samePrice(unitBefore, o.fromUsd) && !samePrice(unitBefore, o.toUsd))
    throw new Error(`The ledger counts in ${dollars(unitBefore)} credits, neither ${dollars(o.fromUsd)} nor ${dollars(o.toUsd)}.`);
  if (!o.dryRun && !samePrice(creditUsd(), o.toUsd))
    throw new Error(`CREDIT_USD is ${dollars(creditUsd())}: change it to ${dollars(o.toUsd)} and redeploy before converting.`);
  const ids = o.workspaceId ? [o.workspaceId] : o.universe ?? (await allWorkspaceIds());
  const results: CreditConversion[] = [];
  for (const id of ids) results.push(await convertWorkspaceCredits(id, { ...o, at, decision: o.decisions?.[id] ?? null }));
  const plan: Plan = { mode: o.mode, k, fromUsd: o.fromUsd, cutoverAt: o.mode === "per-row" ? Number(o.cutoverAt) : null };
  const layer = o.workspaceId ? null : await convertLayer({ ...o, plan, reverse: false }, at);
  const settled = o.dryRun ? { moved: false, waiting: [] as string[] } : await settleLedgerUnit(o.toUsd, o.by ?? null, at, o.universe);
  return {
    dryRun: Boolean(o.dryRun), action: "convert", mode: o.mode, cutoverAt: plan.cutoverAt,
    fromUsd: o.fromUsd, toUsd: o.toUsd, factor: k, ledgerUnitBefore: unitBefore, ledgerUnitAfter: await ledgerUnitNow(),
    waiting: settled.waiting, needsDecision: decisionsOf(results), declinedTopups: declinesOf(results), layer, results, totals: totals(results),
  };
}

export async function reverseAllCredits(o: Options & { workspaceId?: string | null; universe?: string[] }): Promise<ConversionRun> {
  const unitBefore = await ledgerUnitNow();
  const at = o.at ?? Date.now();
  const ids = o.workspaceId ? [o.workspaceId] : o.universe ?? (await allWorkspaceIds());
  const results: CreditConversion[] = [];
  for (const id of ids) results.push(await reverseWorkspaceCredits(id, { ...o, at }));
  const first = results.find((r) => r.status === "reversed" || r.status === "planned");
  const layer = o.workspaceId ? null : await convertLayer({ ...o, plan: null, reverse: true, fromUsd: 0, toUsd: 0 }, at);
  let waiting: string[] = [];
  if (!o.dryRun && first) waiting = (await settleLedgerUnit(first.toUsd, o.by ?? null, at, o.universe)).waiting;
  return {
    dryRun: Boolean(o.dryRun), action: "reverse", mode: first?.mode ?? null, cutoverAt: null,
    fromUsd: first?.fromUsd ?? 0, toUsd: first?.toUsd ?? 0, factor: first ? first.fromUsd / first.toUsd : 1,
    ledgerUnitBefore: unitBefore, ledgerUnitAfter: await ledgerUnitNow(), waiting, needsDecision: [], declinedTopups: [], layer, results, totals: totals(results),
  };
}

/** The record, newest first. */
export async function listCreditConversions(workspaceId?: string): Promise<Record<string, unknown>[]> {
  await conversionsReady();
  const rs = await platformDb().execute(workspaceId
    ? { sql: `SELECT * FROM ${CONVERSIONS_TABLE} WHERE workspace_id=? ORDER BY created_at DESC, rowid DESC`, args: [workspaceId] }
    : `SELECT * FROM ${CONVERSIONS_TABLE} ORDER BY created_at DESC, rowid DESC LIMIT 500`);
  return rs.rows.map((r) => ({ ...r }));
}
