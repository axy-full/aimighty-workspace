import type { Transaction } from "@libsql/client";
import { platformDb, platformReady } from "./platform";
import { creditUsd, creditsFigure, fromDeci, type CreditState } from "./creditTerms";
import { deciCovering, deciOf, deciSql, deciWithin, microSql, unitOf, valueOf } from "./creditUnits";
import type { PlanId } from "./plans";

/*
 * Units. Every lot, debit and paid period states the price of a credit its
 * figures were recorded at (`unit_usd`; NULL is the legacy US$0.10, which is
 * what every row written before this column existed was recorded at). Amounts
 * are stored as whole tenths of a credit in their own unit and never restated;
 * the balance is their VALUE (lib/creditUnits.ts), reported in today's credit.
 * A job's debit is in the unit its terms were admitted at, like its receipt.
 */

/** Platform-only credit bookkeeping. Provider requests never run inside these transactions. */
let readyPromise: Promise<void> | undefined;
let turn: Promise<void> = Promise.resolve();
export async function billingReady(): Promise<void> {
  readyPromise ??= (async () => {
    await platformReady();
    await platformDb().batch(
      [
        `CREATE TABLE IF NOT EXISTS billing_ledgers(workspace_id TEXT PRIMARY KEY, initialized_at INTEGER NOT NULL)`,
        `CREATE TABLE IF NOT EXISTS billing_subscriptions(workspace_id TEXT PRIMARY KEY, provider TEXT NOT NULL,
        subscription_id TEXT NOT NULL UNIQUE, plan_id TEXT NOT NULL, status TEXT NOT NULL, interval TEXT NOT NULL,
        current_period_start INTEGER NOT NULL, current_period_end INTEGER NOT NULL, cancel_at_period_end INTEGER NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL)`,
        `CREATE TABLE IF NOT EXISTS billing_paid_periods(invoice_id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL,
        subscription_id TEXT NOT NULL, plan_id TEXT NOT NULL, interval TEXT NOT NULL, included_credits INTEGER NOT NULL,
        period_start INTEGER NOT NULL, period_end INTEGER NOT NULL, paid_usd REAL NOT NULL, refunded_at INTEGER,
        created_at INTEGER NOT NULL)`,
        `CREATE TABLE IF NOT EXISTS billing_cycles(id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, invoice_id TEXT NOT NULL,
        starts_at INTEGER NOT NULL, ends_at INTEGER NOT NULL, credits INTEGER NOT NULL, grant_id TEXT NOT NULL UNIQUE)`,
        `CREATE TABLE IF NOT EXISTS billing_lots(id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, kind TEXT NOT NULL,
        credits REAL NOT NULL, drawn REAL NOT NULL DEFAULT 0, expires_at INTEGER, off_plan_remaining_ms INTEGER,
        clock_updated_at INTEGER NOT NULL, clock_started_at INTEGER, off_plan_lifetime_ms INTEGER,
        legacy INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL)`,
        `CREATE INDEX IF NOT EXISTS billing_lots_ws ON billing_lots(workspace_id, expires_at, created_at)`,
        `CREATE TABLE IF NOT EXISTS billing_debits(workspace_id TEXT NOT NULL, event_id TEXT NOT NULL,
        credits REAL NOT NULL, legacy INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, PRIMARY KEY(workspace_id,event_id))`,
        `CREATE TABLE IF NOT EXISTS billing_allocations(workspace_id TEXT NOT NULL, event_id TEXT NOT NULL,
        lot_id TEXT NOT NULL, credits REAL NOT NULL, ordinal INTEGER NOT NULL,
        PRIMARY KEY(workspace_id,event_id,lot_id))`,
        `CREATE TABLE IF NOT EXISTS billing_refunds(id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL,
        source_id TEXT NOT NULL, credits REAL NOT NULL, created_at INTEGER NOT NULL)`,
        /* One row per change of the price a workspace's balance is stated at (lib/creditConversion.ts).
           Append-only: a reversal is its own row naming the one it reverses. */
        `CREATE TABLE IF NOT EXISTS billing_unit_conversions(id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL,
        from_usd REAL NOT NULL, to_usd REAL NOT NULL, balance_value INTEGER NOT NULL, balance_before REAL NOT NULL,
        balance_exact REAL NOT NULL, balance_after REAL NOT NULL, rounding_credits REAL NOT NULL,
        rounding_grant_id TEXT, in_flight INTEGER NOT NULL DEFAULT 0, reverses TEXT UNIQUE,
        created_by TEXT, created_at INTEGER NOT NULL)`,
        `CREATE INDEX IF NOT EXISTS billing_unit_conversions_ws ON billing_unit_conversions(workspace_id, created_at)`,
      ],
      "write",
    );
    for (const [table, columns] of Object.entries({
      billing_lots: [
        "clock_started_at INTEGER",
        "off_plan_lifetime_ms INTEGER",
        "unit_usd REAL",
      ],
      billing_debits: ["legacy INTEGER NOT NULL DEFAULT 0", "unit_usd REAL"],
      billing_paid_periods: ["unit_usd REAL"],
    })) {
      const present = new Set(
        (await platformDb().execute(`PRAGMA table_info(${table})`)).rows.map(
          (r) => String(r.name),
        ),
      );
      for (const column of columns)
        if (!present.has(column.split(" ")[0]))
          await platformDb().execute(
            `ALTER TABLE ${table} ADD COLUMN ${column}`,
          );
    }
    await platformDb().execute(
      `UPDATE billing_lots SET clock_started_at=clock_updated_at,off_plan_lifetime_ms=off_plan_remaining_ms WHERE off_plan_remaining_ms IS NOT NULL AND clock_started_at IS NULL`,
    );
  })().catch((error) => {
    readyPromise = undefined;
    throw error;
  });
  await readyPromise;
}

/** A local libsql client shares its connection; serialize all ledger transactions as well as taking the database lock. */
export async function billingTransaction<T>(
  fn: (tx: Transaction, at: number) => Promise<T>,
  at = Date.now(),
): Promise<T> {
  await billingReady();
  const result = turn.then(async () => {
    const tx = await platformDb().transaction("write");
    try {
      const value = await fn(tx, at);
      await tx.commit();
      return value;
    } catch (error) {
      await tx.rollback().catch(() => {});
      throw error;
    } finally {
      tx.close();
    }
  });
  turn = result.then(
    () => {},
    () => {},
  );
  return result;
}

/** Preserve the original day/time when an annual invoice opens monthly credit windows. */
export function addBillingMonths(at: number, months: number): number {
  const d = new Date(at);
  const target = new Date(
    Date.UTC(
      d.getUTCFullYear(),
      d.getUTCMonth() + months,
      1,
      d.getUTCHours(),
      d.getUTCMinutes(),
      d.getUTCSeconds(),
      d.getUTCMilliseconds(),
    ),
  );
  const last = new Date(
    Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0),
  ).getUTCDate();
  target.setUTCDate(Math.min(d.getUTCDate(), last));
  return target.getTime();
}

export type BillingSubscription = {
  planId: PlanId;
  status: string;
  interval: "month" | "year";
  currentPeriodStart: number;
  currentPeriodEnd: number;
  cancelAtPeriodEnd: boolean;
};

function subscriptionFrom(
  r: Record<string, unknown> | undefined,
): BillingSubscription | null {
  return r
    ? {
        planId: String(r.plan_id) as PlanId,
        status: String(r.status),
        interval: r.interval === "year" ? "year" : "month",
        currentPeriodStart: Number(r.current_period_start),
        currentPeriodEnd: Number(r.current_period_end),
        cancelAtPeriodEnd: Boolean(r.cancel_at_period_end),
      }
    : null;
}

async function subscriptionTx(tx: Transaction, workspaceId: string) {
  const rows = await tx.execute({
    sql: `SELECT * FROM billing_subscriptions WHERE workspace_id=?`,
    args: [workspaceId],
  });
  return subscriptionFrom(rows.rows[0] as Record<string, unknown> | undefined);
}

/** Purchased/bonus clocks measure time off a confirmed paid plan. Admin plan labels are never payment evidence. */
async function advancePackClocks(
  tx: Transaction,
  workspaceId: string,
  at: number,
): Promise<void> {
  const paid = await tx.execute({
    sql: `SELECT period_start,CASE WHEN refunded_at IS NULL THEN period_end ELSE MIN(period_end,refunded_at) END AS period_end FROM billing_paid_periods
    WHERE workspace_id=? ORDER BY period_start`,
    args: [workspaceId],
  });
  const lots = await tx.execute({
    sql: `SELECT * FROM billing_lots WHERE workspace_id=? AND off_plan_remaining_ms IS NOT NULL`,
    args: [workspaceId],
  });
  for (const row of lots.rows) {
    const previous = Number(row.clock_started_at);
    if (at < previous) continue;
    // Union paid intervals: overlapping invoices cannot pause a clock twice.
    let protectedMs = 0;
    let covered = previous;
    let protectedUntil = 0;
    for (const p of paid.rows) {
      const start = Number(p.period_start);
      const end = Number(p.period_end);
      const a = Math.max(previous, covered, start);
      const b = Math.min(at, end);
      if (b > a) {
        protectedMs += b - a;
        covered = b;
      }
      if (start <= at && end > at)
        protectedUntil = Math.max(protectedUntil, end);
    }
    const remaining = Math.max(
      0,
      Number(row.off_plan_lifetime_ms) - (at - previous - protectedMs),
    );
    const expires =
      remaining === 0
        ? Math.min(at, Number(row.expires_at ?? at))
        : protectedUntil
          ? null
          : at + remaining;
    await tx.execute({
      sql: `UPDATE billing_lots SET off_plan_remaining_ms=?,clock_updated_at=?,expires_at=? WHERE id=? AND workspace_id=?`,
      args: [remaining, at, expires, String(row.id), workspaceId],
    });
  }
}

async function materializeCycles(
  tx: Transaction,
  workspaceId: string,
  at: number,
): Promise<void> {
  const paid = await tx.execute({
    sql: `SELECT * FROM billing_paid_periods WHERE workspace_id=? AND refunded_at IS NULL AND period_start<=?`,
    args: [workspaceId, at],
  });
  for (const row of paid.rows) {
    const start = Number(row.period_start);
    const end = Number(row.period_end);
    const months = row.interval === "year" ? 12 : 1;
    for (let n = 0; n < months; n++) {
      const a = addBillingMonths(start, n);
      const b =
        n === months - 1 ? end : Math.min(end, addBillingMonths(start, n + 1));
      if (a > at || a >= end || b <= a) break;
      const id = `cycle:${String(row.invoice_id)}:${n}`;
      const grant = `included:${String(row.invoice_id)}:${n}`;
      const credits = Number(row.included_credits);
      // A period's credits are in the unit it was paid at, even when a window opens after the price changed.
      const unit = unitOf(row.unit_usd);
      const inserted = await tx.execute({
        sql: `INSERT OR IGNORE INTO billing_cycles(id,workspace_id,invoice_id,starts_at,ends_at,credits,grant_id) VALUES(?,?,?,?,?,?,?)`,
        args: [id, workspaceId, String(row.invoice_id), a, b, credits, grant],
      });
      if (!inserted.rowsAffected) continue;
      await tx.execute({
        sql: `INSERT INTO credit_grants(id,workspace_id,credits,note,kind,created_at,unit_usd) VALUES(?,?,?,?,?,?,?)`,
        args: [
          grant,
          workspaceId,
          credits,
          `${String(row.plan_id)} included credits`,
          "included",
          a,
          unit,
        ],
      });
      await tx.execute({
        sql: `INSERT INTO billing_lots(id,workspace_id,kind,credits,expires_at,clock_updated_at,created_at,unit_usd) VALUES(?,?,?,?,?,?,?,?)`,
        args: [grant, workspaceId, "included", credits, b, at, a, unit],
      });
    }
  }
}

/** Import old grants/meters together once. Their existing balance and lack of expiry are grandfathered. */
export async function syncBillingLedger(
  tx: Transaction,
  workspaceId: string,
  at: number,
): Promise<void> {
  const first = await tx.execute({
    sql: `INSERT OR IGNORE INTO billing_ledgers(workspace_id,initialized_at) VALUES(?,?)`,
    args: [workspaceId, at],
  });
  const grants = await tx.execute({
    sql: `SELECT g.* FROM credit_grants g LEFT JOIN billing_lots l ON l.id=g.id WHERE g.workspace_id=? AND l.id IS NULL ORDER BY g.created_at,g.id`,
    args: [workspaceId],
  });
  for (const row of grants.rows) {
    const kind = String(row.kind ?? "manual");
    const credits = Number(row.credits);
    const timed =
      !first.rowsAffected &&
      credits > 0 &&
      (kind === "purchase" || kind === "bonus");
    const lifetime = timed ? addBillingMonths(at, 12) - at : null;
    await tx.execute({
      sql: `INSERT INTO billing_lots(id,workspace_id,kind,credits,expires_at,off_plan_remaining_ms,clock_updated_at,clock_started_at,off_plan_lifetime_ms,legacy,created_at,unit_usd) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,
      args: [
        String(row.id),
        workspaceId,
        kind,
        credits,
        lifetime == null ? null : at + lifetime,
        lifetime,
        at,
        at,
        lifetime,
        first.rowsAffected ? 1 : 0,
        Number(row.created_at),
        // A grant's credits stay in the unit they were granted at; NULL is the legacy unit.
        row.unit_usd == null ? null : unitOf(row.unit_usd),
      ],
    });
  }
  await materializeCycles(tx, workspaceId, at);
  await advancePackClocks(tx, workspaceId, at);
  // New rows from old deployments are imported too. Existing debits are reconciled by meter(), never re-drawn here.
  // A debit is compared with its receipt in the debit's own unit, in whole tenths (never REAL equality).
  const billed = deciSql("CASE WHEN m.paid_by_platform=1 THEN COALESCE(m.billed_credits,0) ELSE 0 END");
  const eventMicro = microSql("m.credit_usd"), debitMicro = microSql("d.unit_usd");
  const meters = await tx.execute({
    sql: `SELECT m.*,d.event_id AS known_debit FROM meter_events m LEFT JOIN billing_debits d ON d.workspace_id=m.workspace_id AND d.event_id=m.id
    WHERE m.workspace_id=? AND (d.event_id IS NULL OR ${deciSql("d.credits")}<>CASE WHEN ${eventMicro}=${debitMicro} THEN ${billed}
      ELSE (${billed}*${eventMicro}+${debitMicro}-1)/${debitMicro} END) ORDER BY m.created_at,m.id`,
    args: [workspaceId],
  });
  for (const row of meters.rows) {
    await setCreditDebitTx(
      tx,
      workspaceId,
      String(row.id),
      Number(row.paid_by_platform) ? Number(row.billed_credits ?? 0) : 0,
      at,
      true,
      unitOf(row.credit_usd),
    );
    if (row.known_debit == null)
      await tx.execute({
        sql: `UPDATE billing_debits SET legacy=1 WHERE workspace_id=? AND event_id=?`,
        args: [workspaceId, String(row.id)],
      });
  }
}

/**
 * The balance as a VALUE (lib/creditUnits.ts): what the unexpired (or
 * overdrawn) lots hold, less what debits owe beyond what funds them. Every
 * figure is integer tenths times an integer price, so the sum is exact.
 */
export async function balanceValueTx(
  tx: Transaction,
  workspaceId: string,
  at: number,
): Promise<number> {
  const lots = await tx.execute({
    sql: `SELECT COALESCE(SUM(CASE WHEN ${deciSql("credits")}<${deciSql("drawn")} OR expires_at IS NULL OR expires_at>?
      THEN (${deciSql("credits")}-${deciSql("drawn")})*${microSql("unit_usd")} ELSE 0 END),0) AS v FROM billing_lots WHERE workspace_id=?`,
    args: [at, workspaceId],
  });
  const debt = await tx.execute({
    sql: `SELECT COALESCE((SELECT SUM(${deciSql("credits")}*${microSql("unit_usd")}) FROM billing_debits WHERE workspace_id=?),0)
      -COALESCE((SELECT SUM(${deciSql("a.credits")}*${microSql("l.unit_usd")}) FROM billing_allocations a
        JOIN billing_lots l ON l.id=a.lot_id AND l.workspace_id=a.workspace_id WHERE a.workspace_id=?),0) AS v`,
    args: [workspaceId, workspaceId],
  });
  return Number(lots.rows[0].v) - Number(debt.rows[0].v);
}

export class CreditBalanceError extends Error {
  constructor(
    public readonly needed: number,
    public readonly available: number,
  ) {
    super(
      `This job needs ${creditsFigure(needed)} credits; ${creditsFigure(Math.max(0, available))} are available after reserved jobs.`,
    );
    this.name = "CreditBalanceError";
  }
}

/**
 * Pin a reservation to its funding lots. A completion may record debt; work already billed by a provider cannot disappear.
 *
 * `credits` is the job's charge in the unit its terms were admitted at
 * (`unitUsd`; its receipt's `credit_usd`), rounded up to a whole tenth. A
 * debit keeps the unit it was first written in, and a figure in another unit
 * is restated in it, rounded up. Lots are drawn by value, so a debit in one
 * unit can be funded from lots recorded at another; amounts move in whole
 * tenths of each lot's own unit, and nothing is ever restated in place.
 */
export async function setCreditDebitTx(
  tx: Transaction,
  workspaceId: string,
  eventId: string,
  credits: number,
  at: number,
  allowDebt = false,
  unitUsd?: number,
): Promise<void> {
  if (!Number.isFinite(credits) || credits < 0)
    throw new Error("Invalid credit debit.");
  const prior = await tx.execute({
    sql: `SELECT credits,unit_usd FROM billing_debits WHERE workspace_id=? AND event_id=?`,
    args: [workspaceId, eventId],
  });
  const existing = prior.rows[0];
  const eventUnit = unitUsd ?? (existing ? unitOf(existing.unit_usd) : creditUsd());
  const unit = existing ? unitOf(existing.unit_usd) : eventUnit;
  const charged = Math.max(0, Math.ceil(credits * 10 - 1e-9));
  const target = unit === eventUnit ? charged : deciCovering(valueOf(charged, eventUnit), unit);
  const before = deciOf(existing?.credits);
  const delta = target - before;
  const allocations = await tx.execute({
    sql: `SELECT a.*,l.unit_usd AS lot_unit_usd,l.credits AS lot_credits,l.drawn AS lot_drawn FROM billing_allocations a
      JOIN billing_lots l ON l.id=a.lot_id AND l.workspace_id=a.workspace_id
      WHERE a.workspace_id=? AND a.event_id=? ORDER BY a.ordinal DESC`,
    args: [workspaceId, eventId],
  });
  const allocatedValue = allocations.rows.reduce(
    (sum, r) => sum + valueOf(deciOf(r.credits), unitOf(r.lot_unit_usd)),
    0,
  );
  if (delta > 0) {
    const needValue = valueOf(delta, unit);
    const availableValue = await balanceValueTx(tx, workspaceId, at);
    if (!allowDebt && (needValue > availableValue || availableValue <= 0))
      throw new CreditBalanceError(fromDeci(delta), fromDeci(deciWithin(availableValue, unit)));
    let need = needValue;
    const lots = await tx.execute({
      sql: `SELECT * FROM billing_lots WHERE workspace_id=? AND ${deciSql("credits")}>${deciSql("drawn")} AND ${deciSql("credits")}>0
      AND (expires_at IS NULL OR expires_at>?)
      ORDER BY CASE kind WHEN 'included' THEN 0 WHEN 'welcome' THEN 1 WHEN 'manual' THEN 1 WHEN 'bonus' THEN 2 ELSE 3 END,
      COALESCE(expires_at,9223372036854775807),created_at,id`,
      args: [workspaceId, at],
    });
    let ordinal = allocations.rows.reduce(
      (max, r) => Math.max(max, Number(r.ordinal)),
      0,
    );
    for (const row of lots.rows) {
      if (need <= 0) break;
      const lotUnit = unitOf(row.unit_usd);
      const drawn = deciOf(row.drawn);
      // Whole tenths of the lot's own unit, enough to cover what is still needed.
      const take = Math.min(deciOf(row.credits) - drawn, deciCovering(need, lotUnit));
      if (take <= 0) continue;
      await tx.execute({
        sql: `UPDATE billing_lots SET drawn=? WHERE workspace_id=? AND id=?`,
        args: [fromDeci(drawn + take), workspaceId, String(row.id)],
      });
      const had = await tx.execute({
        sql: `SELECT credits FROM billing_allocations WHERE workspace_id=? AND event_id=? AND lot_id=?`,
        args: [workspaceId, eventId, String(row.id)],
      });
      await tx.execute({
        sql: `INSERT INTO billing_allocations(workspace_id,event_id,lot_id,credits,ordinal) VALUES(?,?,?,?,?)
        ON CONFLICT(workspace_id,event_id,lot_id) DO UPDATE SET credits=excluded.credits`,
        args: [workspaceId, eventId, String(row.id), fromDeci(deciOf(had.rows[0]?.credits) + take), ++ordinal],
      });
      need -= valueOf(take, lotUnit);
    }
  } else if (delta < 0) {
    // Unfunded overrun is removed first, then restore the last allocated sources — never more value than was released.
    let release = Math.max(0, allocatedValue - valueOf(target, unit));
    for (const row of allocations.rows) {
      if (release <= 0) break;
      const lotUnit = unitOf(row.lot_unit_usd);
      const amount = Math.min(deciOf(row.credits), deciWithin(release, lotUnit));
      if (amount <= 0) continue;
      const drawn = await tx.execute({
        sql: `SELECT drawn FROM billing_lots WHERE id=? AND workspace_id=?`,
        args: [String(row.lot_id), workspaceId],
      });
      await tx.execute({
        sql: `UPDATE billing_lots SET drawn=? WHERE id=? AND workspace_id=?`,
        args: [fromDeci(deciOf(drawn.rows[0]?.drawn) - amount), String(row.lot_id), workspaceId],
      });
      await tx.execute({
        sql: `UPDATE billing_allocations SET credits=? WHERE workspace_id=? AND event_id=? AND lot_id=?`,
        args: [fromDeci(deciOf(row.credits) - amount), workspaceId, eventId, String(row.lot_id)],
      });
      release -= valueOf(amount, lotUnit);
    }
  }
  await tx.execute({
    sql: `INSERT INTO billing_debits(workspace_id,event_id,credits,created_at,unit_usd) VALUES(?,?,?,?,?) ON CONFLICT(workspace_id,event_id) DO UPDATE SET credits=excluded.credits`,
    args: [workspaceId, eventId, fromDeci(target), at, unit],
  });
}

export type BillingCreditState = CreditState & {
  includedBalance: number;
  purchasedBalance: number;
  bonusBalance: number;
  otherBalance: number;
  expiredCredits: number;
  nextExpiryAt: number | null;
};
export async function billingStateFor(workspaceId: string, at = Date.now()) {
  return billingTransaction(async (tx) => {
    await syncBillingLedger(tx, workspaceId, at);
    const rows = await tx.execute({
      sql: `SELECT * FROM billing_lots WHERE workspace_id=? ORDER BY created_at DESC`,
      args: [workspaceId],
    });
    /* Every figure below is in today's credits, from exact values: each lot's
       tenths at the price they were recorded at (lib/creditUnits.ts). */
    const now = creditUsd();
    const inNow = (value: number) => fromDeci(deciWithin(value, now));
    const valued = rows.rows.map((r) => {
      const unit = unitOf(r.unit_usd);
      return {
        id: String(r.id),
        kind: String(r.kind),
        creditsValue: valueOf(deciOf(r.credits), unit),
        remainingValue: valueOf(deciOf(r.credits) - deciOf(r.drawn), unit),
        expiresAt: r.expires_at == null ? null : Number(r.expires_at),
        legacy: Boolean(r.legacy),
        unitUsd: unit,
      };
    });
    const lots = valued.map(({ creditsValue, remainingValue, ...l }) => ({
      ...l,
      credits: inNow(creditsValue),
      remaining: inNow(remainingValue),
    }));
    const active = valued.filter((l) => l.expiresAt == null || l.expiresAt > at);
    const sumValue = (kind: string) =>
      active
        .filter((l) => l.kind === kind)
        .reduce((a, l) => a + l.remainingValue, 0);
    const usedRows = await tx.execute({
      sql: `SELECT COALESCE(SUM(${deciSql("credits")}*${microSql("unit_usd")}),0) AS v FROM billing_debits WHERE workspace_id=?`,
      args: [workspaceId],
    });
    const balanceValue = await balanceValueTx(tx, workspaceId, at);
    const expiry = active
      .filter((l) => l.remainingValue > 0 && l.expiresAt != null)
      .map((l) => l.expiresAt!);
    const credits: BillingCreditState = {
      creditUsd: now,
      granted: inNow(valued.reduce((a, l) => a + l.creditsValue, 0)),
      used: inNow(Number(usedRows.rows[0].v)),
      balance: inNow(balanceValue),
      includedBalance: inNow(sumValue("included")),
      purchasedBalance: inNow(sumValue("purchase")),
      bonusBalance: inNow(sumValue("bonus")),
      otherBalance: inNow(balanceValue - sumValue("included") - sumValue("purchase") - sumValue("bonus")),
      expiredCredits: inNow(valued
        .filter((l) => l.expiresAt != null && l.expiresAt <= at)
        .reduce((a, l) => a + Math.max(0, l.remainingValue), 0)),
      nextExpiryAt: expiry.length ? Math.min(...expiry) : null,
    };
    const cycles = await tx.execute({
      sql: `SELECT * FROM billing_cycles WHERE workspace_id=? ORDER BY starts_at DESC LIMIT 24`,
      args: [workspaceId],
    });
    return {
      subscription: await subscriptionTx(tx, workspaceId),
      credits,
      lots: lots.slice(0, 100),
      cycles: cycles.rows.map((r) => ({
        id: String(r.id),
        startsAt: Number(r.starts_at),
        endsAt: Number(r.ends_at),
        credits: Number(r.credits),
        invoiceId: String(r.invoice_id),
      })),
    };
  }, at);
}

export type PaidSubscriptionPeriod = {
  workspaceId: string;
  provider: string;
  subscriptionId: string;
  invoiceId: string;
  planId: PlanId;
  interval: "month" | "year";
  includedCredits: number;
  periodStart: number;
  periodEnd: number;
  paidUsd: number;
  cancelAtPeriodEnd?: boolean;
  /** Provider event timestamp, in milliseconds, used to reject out-of-order state transitions. */
  eventCreatedAt?: number;
};
/** Only a verified paid invoice adapter may call this. A checkout redirect or plan selection is insufficient. */
export async function applyPaidSubscriptionPeriod(
  input: PaidSubscriptionPeriod,
  at = Date.now(),
): Promise<void> {
  if (
    !input.invoiceId ||
    !input.subscriptionId ||
    !["studio", "agency", "production"].includes(input.planId) ||
    !Number.isInteger(input.includedCredits) ||
    input.includedCredits < 0 ||
    !Number.isFinite(input.paidUsd) ||
    !(input.paidUsd > 0) ||
    !Number.isFinite(input.periodStart) ||
    !Number.isFinite(input.periodEnd) ||
    input.periodEnd <= input.periodStart
  )
    throw new Error("Invalid confirmed subscription period.");
  await billingTransaction(async (tx) => {
    await syncBillingLedger(tx, input.workspaceId, at);
    const previous = await tx.execute({
      sql: `SELECT * FROM billing_paid_periods WHERE invoice_id=?`,
      args: [input.invoiceId],
    });
    if (previous.rows.length) {
      const r = previous.rows[0];
      if (
        r.workspace_id !== input.workspaceId ||
        r.subscription_id !== input.subscriptionId ||
        r.plan_id !== input.planId ||
        r.interval !== input.interval ||
        Number(r.period_start) !== input.periodStart ||
        Number(r.period_end) !== input.periodEnd ||
        Number(r.included_credits) !== input.includedCredits ||
        Number(r.paid_usd) !== input.paidUsd
      )
        throw new Error(
          "This invoice is already assigned to different billing terms.",
        );
      return;
    }
    await tx.execute({
      // The included credits are in the price of a credit on the day the period was paid.
      sql: `INSERT INTO billing_paid_periods(invoice_id,workspace_id,subscription_id,plan_id,interval,included_credits,period_start,period_end,paid_usd,created_at,unit_usd) VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
      args: [
        input.invoiceId,
        input.workspaceId,
        input.subscriptionId,
        input.planId,
        input.interval,
        input.includedCredits,
        input.periodStart,
        input.periodEnd,
        input.paidUsd,
        at,
        creditUsd(),
      ],
    });
    await tx.execute({
      sql: `INSERT INTO billing_subscriptions(workspace_id,provider,subscription_id,plan_id,status,interval,current_period_start,current_period_end,cancel_at_period_end,updated_at)
      VALUES(?,?,?,?,'active',?,?,?,?,?) ON CONFLICT(workspace_id) DO UPDATE SET provider=excluded.provider,subscription_id=excluded.subscription_id,
      plan_id=excluded.plan_id,status=CASE WHEN billing_subscriptions.subscription_id=excluded.subscription_id AND billing_subscriptions.status IN ('canceled','cancelled') THEN billing_subscriptions.status ELSE 'active' END,
      interval=excluded.interval,current_period_start=excluded.current_period_start,current_period_end=excluded.current_period_end,
      cancel_at_period_end=excluded.cancel_at_period_end,updated_at=excluded.updated_at WHERE excluded.updated_at>billing_subscriptions.updated_at`,
      args: [
        input.workspaceId,
        input.provider,
        input.subscriptionId,
        input.planId,
        input.interval,
        input.periodStart,
        input.periodEnd,
        input.cancelAtPeriodEnd ? 1 : 0,
        input.eventCreatedAt ?? input.periodStart,
      ],
    });
    await materializeCycles(tx, input.workspaceId, at);
    await advancePackClocks(tx, input.workspaceId, at);
  }, at);
}

/** Status changes do not create credits. Existing funded periods remain usable until their paid end. */
export async function updateSubscriptionStatus(
  input: {
    workspaceId: string;
    subscriptionId: string;
    status: string;
    cancelAtPeriodEnd: boolean;
    eventCreatedAt?: number;
  },
  at = Date.now(),
): Promise<void> {
  if (
    ![
      "active",
      "trialing",
      "past_due",
      "unpaid",
      "canceled",
      "cancelled",
      "incomplete",
      "incomplete_expired",
      "paused",
    ].includes(input.status)
  )
    throw new Error("Invalid subscription status.");
  await billingTransaction(async (tx) => {
    await syncBillingLedger(tx, input.workspaceId, at);
    const occurred = input.eventCreatedAt ?? at;
    await tx.execute({
      sql: `UPDATE billing_subscriptions SET status=?,cancel_at_period_end=?,updated_at=? WHERE workspace_id=? AND subscription_id=? AND updated_at<?`,
      args: [
        input.status,
        input.cancelAtPeriodEnd ? 1 : 0,
        occurred,
        input.workspaceId,
        input.subscriptionId,
        occurred,
      ],
    });
  }, at);
}

/** A verified refund/chargeback removes credits from their original lot. Already-spent credits become debt, not free usage. */
export async function reverseCreditGrant(
  input: {
    workspaceId: string;
    refundId: string;
    grantId: string;
    credits: number;
  },
  at = Date.now(),
): Promise<void> {
  if (!input.refundId || !Number.isFinite(input.credits) || input.credits <= 0)
    throw new Error("Invalid credit reversal.");
  await billingTransaction(async (tx) => {
    await syncBillingLedger(tx, input.workspaceId, at);
    await reverseCreditGrantTx(tx, input, at);
  }, at);
}

async function reverseCreditGrantTx(
  tx: Transaction,
  input: {
    workspaceId: string;
    refundId: string;
    grantId: string;
    credits: number;
  },
  at: number,
): Promise<void> {
  const previous = await tx.execute({
    sql: `SELECT * FROM billing_refunds WHERE id=?`,
    args: [input.refundId],
  });
  if (previous.rows[0]) {
    const r = previous.rows[0];
    if (
      r.workspace_id !== input.workspaceId ||
      r.source_id !== input.grantId ||
      Number(r.credits) !== input.credits
    )
      throw new Error("This refund already names different credits.");
    return;
  }
  const lots = await tx.execute({
    sql: `SELECT * FROM billing_lots WHERE workspace_id=? AND id=?`,
    args: [input.workspaceId, input.grantId],
  });
  const lot = lots.rows[0];
  // The refund names credits in the grant's own unit, in whole tenths.
  const refunded = Math.ceil(input.credits * 10 - 1e-9);
  if (!lot || refunded > deciOf(lot.credits))
    throw new Error("The refund exceeds the remaining grant amount.");
  const unit = lot.unit_usd == null ? null : unitOf(lot.unit_usd);
  await tx.execute({
    sql: `INSERT INTO billing_refunds(id,workspace_id,source_id,credits,created_at) VALUES(?,?,?,?,?)`,
    args: [input.refundId, input.workspaceId, input.grantId, input.credits, at],
  });
  await tx.execute({
    sql: `UPDATE billing_lots SET credits=? WHERE workspace_id=? AND id=?`,
    args: [fromDeci(deciOf(lot.credits) - refunded), input.workspaceId, input.grantId],
  });
  const marker = `refund:${input.refundId}`;
  await tx.execute({
    sql: `INSERT INTO credit_grants(id,workspace_id,credits,note,kind,created_at,unit_usd) VALUES(?,?,?,?,?,?,?)`,
    args: [
      marker,
      input.workspaceId,
      -fromDeci(refunded),
      "Payment reversed",
      String(lot.kind),
      at,
      unit,
    ],
  });
  // The negative grant is represented by the original lot's reduction; this marker prevents importing it twice.
  await tx.execute({
    sql: `INSERT INTO billing_lots(id,workspace_id,kind,credits,clock_updated_at,created_at,unit_usd) VALUES(?,?,?,0,?,?,?)`,
    args: [marker, input.workspaceId, String(lot.kind), at, at, unit],
  });
}

/** Full invoice reversal. Cash refunds are issued by the payment provider, never by this ledger helper. */
export async function reversePaidSubscriptionPeriod(
  input: { workspaceId: string; invoiceId: string; refundId: string },
  at = Date.now(),
): Promise<void> {
  await billingTransaction(async (tx) => {
    await syncBillingLedger(tx, input.workspaceId, at);
    const periods = await tx.execute({
      sql: `SELECT * FROM billing_paid_periods WHERE workspace_id=? AND invoice_id=?`,
      args: [input.workspaceId, input.invoiceId],
    });
    if (!periods.rows[0]) throw new Error("No paid invoice in this workspace.");
    if (periods.rows[0].refunded_at != null) return;
    const grants = await tx.execute({
      sql: `SELECT l.* FROM billing_cycles c JOIN billing_lots l ON l.id=c.grant_id WHERE c.workspace_id=? AND c.invoice_id=?`,
      args: [input.workspaceId, input.invoiceId],
    });
    for (const lot of grants.rows)
      if (Number(lot.credits) > 0)
        await reverseCreditGrantTx(
          tx,
          {
            workspaceId: input.workspaceId,
            refundId: `${input.refundId}:${String(lot.id)}`,
            grantId: String(lot.id),
            credits: Number(lot.credits),
          },
          at,
        );
    await tx.execute({
      sql: `UPDATE billing_paid_periods SET refunded_at=? WHERE workspace_id=? AND invoice_id=?`,
      args: [at, input.workspaceId, input.invoiceId],
    });
    await tx.execute({
      sql: `UPDATE billing_subscriptions SET status='unpaid',updated_at=? WHERE workspace_id=? AND subscription_id=? AND current_period_start=? AND current_period_end=?`,
      args: [
        at,
        input.workspaceId,
        String(periods.rows[0].subscription_id),
        Number(periods.rows[0].period_start),
        Number(periods.rows[0].period_end),
      ],
    });
    await advancePackClocks(tx, input.workspaceId, at);
  }, at);
}

/** Exact funding attribution for statements, including reservations and subsequent corrections. */
export async function creditFundingFor(
  workspaceId: string,
  from: number,
  to: number,
): Promise<{ eventId: string; kind: string; credits: number }[]> {
  return billingTransaction(async (tx, at) => {
    await syncBillingLedger(tx, workspaceId, at);
    /* Each allocation's value (its lot's tenths at the lot's price), stated in
       the credits of the job it funds — the unit that job's receipt is in. */
    const rows = await tx.execute({
      sql: `SELECT a.event_id,CASE WHEN d.legacy=1 THEN 'legacy' ELSE l.kind END AS kind,
      SUM(${deciSql("a.credits")}*${microSql("l.unit_usd")}) AS value,${microSql("d.unit_usd")} AS debit_micro FROM billing_allocations a
      JOIN billing_lots l ON l.id=a.lot_id AND l.workspace_id=a.workspace_id JOIN meter_events m ON m.id=a.event_id AND m.workspace_id=a.workspace_id
      JOIN billing_debits d ON d.workspace_id=a.workspace_id AND d.event_id=a.event_id
      WHERE a.workspace_id=? AND m.created_at>=? AND m.created_at<? GROUP BY a.event_id,CASE WHEN d.legacy=1 THEN 'legacy' ELSE l.kind END`,
      args: [workspaceId, from, to],
    });
    return rows.rows.map((r) => ({
      eventId: String(r.event_id),
      kind: String(r.kind),
      credits: Number(r.value) / Number(r.debit_micro) / 10,
    }));
  });
}

export async function paidPlanEntitlement(
  workspaceId: string,
  at = Date.now(),
): Promise<{ planId: PlanId | null; subscribedBefore: boolean }> {
  return billingTransaction(
    (tx) => paidPlanEntitlementTx(tx, workspaceId, at),
    at,
  );
}

export async function paidPlanEntitlementTx(
  tx: Transaction,
  workspaceId: string,
  at: number,
): Promise<{ planId: PlanId | null; subscribedBefore: boolean }> {
  const rows = await tx.execute({
    sql: `SELECT plan_id FROM billing_paid_periods WHERE workspace_id=? AND refunded_at IS NULL
      AND period_start<=? AND period_end>? ORDER BY period_start DESC,created_at DESC LIMIT 1`,
    args: [workspaceId, at, at],
  });
  const history = await tx.execute({
    sql: `SELECT 1 FROM billing_paid_periods WHERE workspace_id=? LIMIT 1`,
    args: [workspaceId],
  });
  return {
    planId: rows.rows[0] ? (String(rows.rows[0].plan_id) as PlanId) : null,
    subscribedBefore: history.rows.length > 0,
  };
}

export function effectivePlanId(
  paid: { planId: PlanId | null; subscribedBefore: boolean } | null,
  explicit: PlanId | null | undefined,
): PlanId | null {
  return (
    paid?.planId ??
    (explicit && explicit !== "invite" ? explicit : null) ??
    (paid?.subscribedBefore ? "invite" : (explicit ?? null))
  );
}
