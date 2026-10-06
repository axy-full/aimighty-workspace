/**
 * A production's budget, pure (no database): the workspace's budget per production as typed, the share at which
 * paid work stops to ask, and where that is. lib/caps.ts reads the settings and enforces; screens word the same
 * figures from here.
 */

const whole = (n: number) => Math.round(n).toLocaleString("en-US");

/**
 * The workspace's budget per production (Settings › Spending rules), in credits: what a production with no cap of
 * its own follows. Blank, nonsense or below 1 is none. Pure; `workspaceBudget()` reads the setting.
 */
export function cleanBudget(v: unknown): number | null {
  const text = String(v ?? "").trim();
  if (!/^\d{1,7}$/.test(text)) return null;
  const n = Number(text);
  return n >= 1 && n <= 1_000_000 ? n : null;
}

/** The share of a production's budget at which paid work stops to ask (the workspace's `capWarnPct`, 80 unless set). */
export function cleanWarnPct(v: unknown): number {
  return Math.max(1, Math.min(100, Math.round(Number(v)) || 80));
}

/**
 * The pause at a share of the budget (Settings › Spending rules: "the 80 % pause asks at 320 cr"), with nothing read.
 * `pauseAt` is that share of the cap in whole credits (rounded down, so a 401 cr budget pauses at 320 cr, never past
 * it); `reached` is whether this job (`needs`) would take what is spent to it or past it. No cap, no pause. Pure: the
 * run's gate asks a person when it is reached, and the board's card shows the same figures.
 */
export type BudgetPause = { cap: number; spent: number; needs: number; pauseAt: number; pct: number; reached: boolean };
export function budgetPause(o: { cap: number | null; spent: number; needs: number; warnPct: number }): BudgetPause | null {
  if (o.cap == null || !(o.cap > 0)) return null;
  const pct = cleanWarnPct(o.warnPct);
  const pauseAt = Math.floor((o.cap * pct) / 100 + 1e-9);
  const spent = Math.max(0, o.spent), needs = Math.max(0, o.needs);
  return { cap: o.cap, spent, needs, pauseAt, pct, reached: spent + needs >= pauseAt - 1e-9 };
}

/** "Paused at 80 % of the budget: 320 of 400 cr used. Continue or stop." (used: settled, and held for work in flight, as the gate counts it) */
export function budgetPauseLine(p: Pick<BudgetPause, "pct" | "spent" | "cap">): string {
  return `Paused at ${p.pct} % of the budget: ${whole(p.spent)} of ${whole(p.cap)} cr used. Continue or stop.`;
}
