/**
 * A production's budget, pure (no database): the workspace's budget per production as typed, the share at which the
 * producer is warned (lib/caps.ts checkCap) and the plan card says where a plan would take it, and where that is.
 * lib/caps.ts reads the settings and enforces the cap; screens word the same figures from here. (Nothing pauses paid
 * work at the share any more: that ask was Auto's, and Auto went on 20 Oct 2026; its Paused card went on 21 Oct 2026.)
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

/** The share of a production's budget at which the producer is warned (the workspace's `capWarnPct`, 80 unless set). */
export function cleanWarnPct(v: unknown): number {
  return Math.max(1, Math.min(100, Math.round(Number(v)) || 80));
}

/**
 * The share of the budget (Settings › Spending rules: "warns at 320 cr (80 %)"), with nothing read.
 * `pauseAt` is that share of the cap in whole credits (rounded down, so a 401 cr budget pauses at 320 cr, never past
 * it); `reached` is whether this job (`needs`) would take what is spent to it or past it. No cap, no share. Pure: the
 * budget route and the board's card show these figures; no gate stops at them (Auto's ask went on 20 Oct 2026).
 */
export type BudgetPause = { cap: number; spent: number; needs: number; pauseAt: number; pct: number; reached: boolean };
export function budgetPause(o: { cap: number | null; spent: number; needs: number; warnPct: number }): BudgetPause | null {
  if (o.cap == null || !(o.cap > 0)) return null;
  const pct = cleanWarnPct(o.warnPct);
  const pauseAt = Math.floor((o.cap * pct) / 100 + 1e-9);
  const spent = Math.max(0, o.spent), needs = Math.max(0, o.needs);
  return { cap: o.cap, spent, needs, pauseAt, pct, reached: spent + needs >= pauseAt - 1e-9 };
}

/**
 * Where a plan's "at most" (its ceiling, the server's quote) would take a production against its cap or budget, said
 * before the plan is approved (the plan card at the gate). An approved plan runs without a tap up to the production's
 * cap (lib/workbench/plan-approval.ts); nothing stops at the 80 % share (it warns; Auto's ask there went on 20 Oct 2026). `total` is the plan's renders
 * without fixes (T); `atMost` is its ceiling with every fix (2T). So the card says, in one line:
 *  - "This plan's at most N cr is more than <name> has left (M cr); it will stop at the cap." when even its renders
 *    without fixes don't fit (or "… it goes past the cap with a warning." when the workspace's rule at the cap only warns);
 *  - "… (M cr). If it uses all its fixes, it stops at the cap." (or "… it goes past the cap with a warning.") when its
 *    renders fit and only the fixes would not;
 *  - "This plan can take <name> past 80 % of its budget (N of M cr)." when it would reach the share;
 *  - nothing otherwise, or when an admin unlocked the production past its cap. Pure; nothing here spends.
 */
export function planBudgetLine(o: { name: string; total: number; atMost: number; cap: number | null; used: number; warnPct: number; unlocked: boolean; atCap: "producer" | "stop" | "warn" }): string | null {
  if (o.cap == null || !(o.cap > 0) || o.unlocked || !(o.atMost > 0)) return null;
  const name = o.name.trim() || "this production";
  const left = Math.max(0, o.cap - o.used);
  if (o.atMost > left + 1e-9) {
    const over = `This plan’s at most ${whole(o.atMost)} cr is more than ${name} has left (${whole(left)} cr)`;
    const atCap = o.atCap === "warn" ? "goes past the cap with a warning." : "stops at the cap.";
    /* Its renders fit; only the fixes would take it to the cap. */
    if (o.total <= left + 1e-9) return `${over}. If it uses all its fixes, it ${atCap}`;
    return `${over}; ${o.atCap === "warn" ? "it goes past the cap with a warning." : "it will stop at the cap."}`;
  }
  const pause = budgetPause({ cap: o.cap, spent: o.used, needs: o.atMost, warnPct: o.warnPct })!;
  if (pause.reached) return `This plan can take ${name} past ${pause.pct} % of its budget (${whole(o.used + o.atMost)} of ${whole(o.cap)} cr).`;
  return null;
}
