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

/**
 * Where a plan's "at most" (its ceiling, the server's quote) would take a production against its cap or budget, said
 * before the plan is approved (the plan card at the gate). An approved plan runs without a tap up to the production's
 * cap (lib/workbench/plan-approval.ts); Atomik's 80 % ask is for Auto drafts only. So the card says, in one line:
 *  - "This plan's at most N cr is more than <name> has left (M cr); it will stop at the cap." when it cannot all fit
 *    (or "… it goes past the cap with a warning." when the workspace's rule at the cap only warns);
 *  - "This plan can take <name> past 80 % of its budget (N of M cr)." when it would reach the share;
 *  - nothing otherwise, or when an admin unlocked the production past its cap. Pure; nothing here spends.
 */
export function planBudgetLine(o: { name: string; atMost: number; cap: number | null; used: number; warnPct: number; unlocked: boolean; atCap: "producer" | "stop" | "warn" }): string | null {
  if (o.cap == null || !(o.cap > 0) || o.unlocked || !(o.atMost > 0)) return null;
  const name = o.name.trim() || "this production";
  const left = Math.max(0, o.cap - o.used);
  if (o.atMost > left + 1e-9) {
    return `This plan’s at most ${whole(o.atMost)} cr is more than ${name} has left (${whole(left)} cr); ${o.atCap === "warn" ? "it goes past the cap with a warning." : "it will stop at the cap."}`;
  }
  const pause = budgetPause({ cap: o.cap, spent: o.used, needs: o.atMost, warnPct: o.warnPct })!;
  if (pause.reached) return `This plan can take ${name} past ${pause.pct} % of its budget (${whole(o.used + o.atMost)} of ${whole(o.cap)} cr).`;
  return null;
}
