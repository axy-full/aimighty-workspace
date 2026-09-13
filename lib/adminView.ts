/**
 * The platform desk's arithmetic (SOW v2 §7.13, board 12h), pure so the desk,
 * the admin routes and the tests read one rule each:
 *
 *   the grant budget   §7A guardrail 1 — welcome grants a cycle may commit
 *   the 25% flag       §7A guardrail 3 — a studio's share of engine spend
 *   the floor          §7A floor guard — a margin under 10%
 *   two lines of copy  the sub-bar and the "starts with" line
 *
 * Nothing here reads the clock, the database or the environment: every
 * number is handed in, every string is handed back.
 */

/** A studio over this share of the platform's engine spend is flagged (§7A guardrail 3). */
export const OVER_SHARE = 0.25;
/** A margin under this is the floor (§7A floor guard). */
export const UNDER_MARGIN = 0.10;
/** The floor guard's window, in days. */
export const FLOOR_GUARD_DAYS = 7;
/** Fewer jobs than this in the window is noise, not a margin. */
export const FLOOR_GUARD_MIN_JOBS = 20;

/* ── money ──────────────────────────────────────────────────────────────── */

/** Whole dollars with a thousands separator: $4,820. */
export const fmtUsd = (n: number): string => `$${Math.round(Math.max(0, n)).toLocaleString("en-US")}`;
/** A margin as the desk prints it: 33%, or an em dash when nothing was billed. */
export const fmtPct = (p: number | null): string => (p == null ? "—" : `${Math.round(p * 100)}%`);

/**
 * The pricing view of a margin: what the credits are worth at the rate,
 * less what the engines charged, over what the credits are worth. Null when
 * nothing was billed — a margin on zero revenue is not a number. No funded
 * fraction here: this asks whether the multiplier still holds over cost, not
 * whether anyone paid for the credits.
 */
export function marginPctOf(billedCredits: number, engineCostUsd: number, creditUsd: number): number | null {
  const revenue = billedCredits * creditUsd;
  if (!(revenue > 0)) return null;
  return (revenue - engineCostUsd) / revenue;
}

/* ── the grant budget ───────────────────────────────────────────────────── */

export type GrantBudgetInput = {
  /** Credits one welcome grant is worth — welcomeGrant(), never typed. */
  grantCredits: number;
  /** Dollars a credit is worth — creditUsd(). */
  creditUsd: number;
  /** Credits granted with kind welcome since the cycle opened. */
  welcomeCreditsThisCycle: number;
  /** Sign-up codes issued this cycle, unused and unexpired: each will grant once accepted. */
  openCodesThisCycle: number;
  /** The cycle's budget in dollars, or null for none. */
  budgetUsd: number | null;
};

export type GrantBudgetState = {
  budgetUsd: number | null;
  /** Dollars of welcome credits already granted this cycle. */
  grantedUsd: number;
  /** Granted plus what the open codes will grant when accepted. */
  committedUsd: number;
  grantCredits: number;
  /** Dollars one grant is worth. */
  usdEach: number;
};

export function grantBudgetMath(i: GrantBudgetInput): GrantBudgetState {
  const grantCredits = Math.max(0, i.grantCredits);
  const usdEach = grantCredits * i.creditUsd;
  const grantedUsd = Math.max(0, i.welcomeCreditsThisCycle) * i.creditUsd;
  const committedUsd = grantedUsd + Math.max(0, i.openCodesThisCycle) * usdEach;
  return { budgetUsd: i.budgetUsd, grantedUsd, committedUsd, grantCredits, usdEach };
}

/** May `n` more codes be issued inside the budget? Always, when there is no budget. */
export function grantBudgetRoom(s: GrantBudgetState, n: number): boolean {
  if (s.budgetUsd == null) return true;
  return s.committedUsd + Math.max(0, n) * s.usdEach <= s.budgetUsd + 1e-9;
}

/** The 409 the desk shows when the budget will not take another code. */
export function grantBudgetSpentLine(s: GrantBudgetState, month: string): string {
  return `The grant budget for ${month} is spent: ${fmtUsd(s.committedUsd)} of ${fmtUsd(s.budgetUsd ?? 0)} committed.`;
}

/* ── the flags ──────────────────────────────────────────────────────────── */

/** A studio's share of the platform's engine spend, 0 when there is none. Internal spend is out of the denominator. */
export function shareOf(engineCostUsd: number, totalEngineCostUsd: number): number {
  if (!(totalEngineCostUsd > 0)) return 0;
  return Math.max(0, engineCostUsd) / totalEngineCostUsd;
}

export function flagsFor(share: number, marginPct: number | null): { overShare: boolean; underMargin: boolean } {
  return { overShare: share > OVER_SHARE, underMargin: marginPct != null && marginPct < UNDER_MARGIN };
}

/** The floor guard fires on a provider with enough jobs to mean it and a margin under the floor. */
export function floorGuardFires(row: { jobs: number; marginPct: number | null }): boolean {
  return row.jobs >= FLOOR_GUARD_MIN_JOBS && row.marginPct != null && row.marginPct < UNDER_MARGIN;
}

/* ── the copy ───────────────────────────────────────────────────────────── */

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
/** The UTC month a cycle opens in, as a word: September. */
export const monthLabel = (cycleStartMs: number): string => MONTHS[new Date(cycleStartMs).getUTCMonth()];

/** The sub-bar's one Mono line: SEPTEMBER · ENGINE SPEND $4,820 · MARGIN 33% · GRANTS $410 OF $1,000. */
export function subBarLine(t: { cycleStart: number; engineCostUsd: number; marginPct: number | null; grantsUsd: number; grantBudgetUsd: number | null }): string {
  const grants = t.grantBudgetUsd == null ? `GRANTS ${fmtUsd(t.grantsUsd)}` : `GRANTS ${fmtUsd(t.grantsUsd)} OF ${fmtUsd(t.grantBudgetUsd)}`;
  return [monthLabel(t.cycleStart).toUpperCase(), `ENGINE SPEND ${fmtUsd(t.engineCostUsd)}`, `MARGIN ${fmtPct(t.marginPct)}`, grants].join(" · ");
}

const plural = (n: number, one: string, many = `${one}s`): string => `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;

/** "What every new studio starts with", one line: 12 Setup rows · 9 rules · 2 recipes · a demo production · caps at 400 cr, warn at 80% · grant 250 cr. */
export function defaultsLine(d: { setupRows: number; rules: number; recipes: number; starter: string; capCredits: number | null; warnPct: number; grant: number }): string {
  const caps = d.capCredits == null ? "caps at no cap" : `caps at ${d.capCredits.toLocaleString("en-US")} cr`;
  return [
    plural(d.setupRows, "Setup row"),
    plural(d.rules, "rule"),
    plural(d.recipes, "recipe"),
    d.starter,
    `${caps}, warn at ${Math.round(d.warnPct)}%`,
    `grant ${Math.round(d.grant).toLocaleString("en-US")} cr`,
  ].join(" · ");
}
