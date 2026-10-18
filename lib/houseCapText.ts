/**
 * The house workspace's monthly cap, as words and arithmetic.
 *
 * The house is never billed in credits (lib/houseWorkspace.ts), so nothing but a dollar cap stands between its jobs and
 * the studio's own engine accounts. The owner's decision of 15 October 2026: "Monthly cap on the house workspace: $500,
 * warning at 80%". The cap is what the engines charge a month (the meter's cost, in dollars), from the 1st of the UTC calendar month (lib/cycle.ts). The platform owner
 * can change the figure on /admin; with none set it is HOUSE_CAP_DEFAULT_USD, so the house is never uncapped.
 *
 * Pure, no imports: the browser reads it (lib/houseCap.ts holds the server's half).
 */

/** What the house may spend on the engines a month until the platform owner sets another figure. */
export const HOUSE_CAP_DEFAULT_USD = 500;
/** The share of the cap at which the warning shows and the platform owner is told, once a month for each figure the cap is set to. */
export const HOUSE_CAP_WARN_PCT = 80;

export type HouseCapView = {
  /** The cap in force, dollars a month. */
  capUsd: number;
  /** Where it came from: the platform owner's own figure, or the default. */
  source: "own" | "default";
  /** What the engines charged the house this month, dollars (running jobs at their hold). */
  spentUsd: number;
  /** Whole percent of the cap spent, rounded down; 100 when the cap is 0. */
  pct: number;
  warn: boolean;
  stop: boolean;
};

const usdText = (n: number) => `$${n.toLocaleString("en-US", { minimumFractionDigits: Number.isInteger(n) ? 0 : 2, maximumFractionDigits: 2 })}`;

/** Where a month's spend stands against the cap: warn from the warning line, stop at the cap. */
export function houseCapState(capUsd: number, spentUsd: number, source: "own" | "default" = "default"): HouseCapView {
  const spent = Math.max(0, spentUsd);
  const pct = capUsd > 0 ? Math.min(100, Math.floor((spent / capUsd) * 100 + 1e-9)) : 100;
  const stop = spent >= capUsd - 1e-9;
  return { capUsd, source, spentUsd: spent, pct, stop, warn: stop || spent >= (capUsd * HOUSE_CAP_WARN_PCT) / 100 - 1e-9 };
}

/** "82% of this month's $500 used ($410)": the warning, with the figure as it stands. The team sees the engines' dollars (owner, 16 Oct 2026). */
export const houseCapWarning = (v: Pick<HouseCapView, "capUsd" | "pct" | "spentUsd">): string => `${v.pct}% of this month's ${usdText(v.capUsd)} used (${usdText(Math.round(v.spentUsd * 100) / 100)})`;

/** What the month stands at, for the house's own screen: "$40 of $500 used · 8%". */
export const houseCapSpentText = (v: Pick<HouseCapView, "capUsd" | "pct" | "spentUsd">): string => `${usdText(Math.round(v.spentUsd * 100) / 100)} of ${usdText(v.capUsd)} used · ${v.pct}%`;

/** What a job hears when it would pass the cap. Only the platform owner raises it. */
export const HOUSE_CAP_REACHED = "The house workspace has reached its monthly engine cap. The platform owner can raise it.";

/** The cap in dollars as the desk shows it: "$500" or "$62.50". */
export const houseCapUsdText = usdText;
