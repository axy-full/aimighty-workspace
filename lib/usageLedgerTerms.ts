/**
 * The usage ledger, per job: its row shapes, its states and their words.
 *
 * GET /api/usage?rows=1 answers in the one unit the workspace pays in. A
 * workspace on credits reads the meter (lib/meter.ts) — what admission
 * reserved, then settled or released — and its rows carry `credits` and
 * nothing else: no dollar field exists on the type. A workspace that pays its
 * vendors (the studio's own, or one on its own keys) reads its takes in
 * dollars. `?rows=connected` is the viewer's own connected account, in that
 * provider's credits as quoted — never converted at the credit rate.
 *
 * Pure, with no imports, so the route, its CSV, the Usage tab and the
 * Inspector read one definition and a unit test can pin it.
 */

export type LedgerState =
  | "charged" | "held" | "running" | "not-billed" | "own-key"
  | "failed-not-billed" | "failed-charged" | "failed-unknown" | "waiting" | "unpriced";

/**
 * A failed job's row also says why, in the product's words (`why`, lib/errors.ts),
 * and — only where the money was the workspace's own (its own keys, or its
 * connected account) — what the provider did with the charge, in the
 * provider's own unit (`provider`). A credit row never carries the provider's
 * side: what Particl charged is the row's own amount.
 */
export type CreditLedgerRow = { id: string; at: number; who: string | null; engine: string; kind: string; credits: number; state: LedgerState; why?: string | null };
export type DollarLedgerRow = { id: string; at: number; who: string | null; engine: string; kind: string; usd: number | null; state: LedgerState; why?: string | null; provider?: string | null };

export type ConnectedState = "completed" | "pending" | "uncertain" | "failed";
export type ConnectedLedgerRow = { id: string; at: number; workflow: string; project: string | null; quotedCredits: number; state: ConnectedState; why?: string | null; provider?: string | null };

type Page<Unit, Row, Totals> = { unit: Unit; month: string | null; months?: string[]; totals?: Totals; rows: Row[]; next: string | null };
export type CreditLedgerPage = Page<"credits", CreditLedgerRow, { jobs: number; charged: number; held: number; notBilled: number }>;
export type DollarLedgerPage = Page<"usd", DollarLedgerRow, { jobs: number; charged: number; notBilled: number }>;
export type LedgerPage = CreditLedgerPage | DollarLedgerPage;
export type ConnectedLedgerPage = Page<"higgsfield_credits", ConnectedLedgerRow, { jobs: number; quoted: number }> & { basis: "approved_quotes"; scope: "own_account" };

/**
 * A metered job, read off the ledger alone. Credits are what the meter holds
 * for the job — a reservation while it runs, the settled bill once it ends,
 * zero once a reservation is released — so "not billed" is only ever said of
 * a job the ledger shows at zero: a released reservation, a job that cost
 * nothing, or one metered unbilled (a failed agent run keeps its vendor cost
 * and bills nothing). A job on the workspace's own key for that vendor paid
 * no credits: the money left its own account.
 */
export function creditLedgerState(status: string, credits: number, paidByPlatform: boolean): LedgerState {
  const billed = Number.isFinite(credits) && credits > 0;
  if (status === "running") return billed ? "held" : "running";
  if (status === "failed") return billed ? "failed-charged" : "failed-not-billed";
  if (status === "succeeded") return billed ? "charged" : paidByPlatform ? "not-billed" : "own-key";
  /* The meter writes no other status; anything else is not called settled. */
  return billed ? "held" : "running";
}

/**
 * A take in a workspace that pays its vendors. Missing accounting evidence
 * is unknown, including when a render failed. The money is the workspace's
 * own with its vendor, so a failed take's recorded zero is only Particl's
 * metering (a refused request may still be charged): it reads "not billed"
 * only when `uncharged` confirms it — the provider's own recorded word
 * (refunded, not charged), or a take discarded before it was ever sent.
 */
export function dollarLedgerState(status: string, usd: number | null, uncharged = false): LedgerState {
  const billed = usd != null && Number.isFinite(usd) && usd > 0;
  if (status === "succeeded") return billed ? "charged" : usd == null ? "unpriced" : "not-billed";
  if (status === "failed" || status === "cancelled") return billed ? "failed-charged" : uncharged ? "failed-not-billed" : "failed-unknown";
  if (status === "held") return "waiting";
  return "running";
}

/** The connected account's own job states (lib/higgsfield-consumer/activity.ts). */
export function connectedLedgerState(status: string): ConnectedState {
  if (status === "completed" || status === "uncertain" || status === "failed") return status;
  return "pending";
}

export const LEDGER_LABEL: Record<LedgerState, string> = {
  charged: "Charged",
  held: "Held",
  running: "Running",
  "not-billed": "Not billed",
  "own-key": "Own key · not billed",
  "failed-not-billed": "Failed · not billed",
  "failed-charged": "Failed · charged",
  "failed-unknown": "Failed · charge unknown",
  waiting: "Waiting",
  unpriced: "No cost recorded",
};

export const CONNECTED_LABEL: Record<ConnectedState, string> = {
  completed: "Completed",
  pending: "Pending",
  uncertain: "Uncertain",
  failed: "Failed",
};

const WORKFLOWS: Record<string, string> = {
  generation: "Generation", "marketing-video": "Marketing video", "marketing-template": "Marketing template",
  genjutsu: "Genjutsu", "voice-tool": "Voice tool", shorts: "Shorts", "reference-match": "Reference match", virality: "Virality",
};
export const workflowLabel = (workflow: string): string => WORKFLOWS[workflow] ?? "Connected job";

export const fmtLedgerCredits = (n: number): string => `${n.toLocaleString("en-US", { maximumFractionDigits: 2 })} cr`;
export const fmtLedgerUsd = (n: number): string => `$${n.toFixed(n < 1 ? 3 : 2)}`;
export const fmtConnectedCredits = (n: number): string => `${n.toLocaleString("en-US", { maximumFractionDigits: 8 })} connected cr`;

/** What a row's amount column says: blank for work that has not been priced. */
export function ledgerAmount(row: CreditLedgerRow | DollarLedgerRow): string {
  if ("credits" in row) return row.state === "running" ? "—" : fmtLedgerCredits(row.credits);
  return row.usd == null || row.state === "running" || row.state === "waiting" ? "—" : fmtLedgerUsd(row.usd);
}

/** "2026-09" → "Sep 2026" (the month is UTC, as statements count it). */
export function monthLabel(month: string): string {
  const m = /^(\d{4})-(\d{2})$/.exec(month);
  if (!m) return month;
  return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, 1)).toLocaleDateString("en-US", { month: "short", year: "numeric", timeZone: "UTC" });
}

/**
 * The Inspector's "Settled" fact for one take, from the ledger's own row. A
 * take the connected account made is the provider's credits as quoted. The
 * unit is whatever the server said this workspace pays in, so a dollar sign
 * can only appear where the route itself answered in dollars.
 */
export function settledFact(page: { unit?: unknown; rows?: unknown } | null, quote: string | null, failed = false): string {
  if (quote) return quote;
  if (failed) return "Could not be read";
  if (!page) return "Reading…";
  const row = Array.isArray(page.rows) ? (page.rows[0] as CreditLedgerRow | DollarLedgerRow | undefined) : undefined;
  if (!row || (page.unit !== "credits" && page.unit !== "usd")) return "—";
  if (page.unit === "credits" && !("credits" in row)) return "—";
  if (page.unit === "usd" && !("usd" in row)) return "—";
  switch (row.state) {
    case "held": return `Held · ${ledgerAmount(row)}`;
    case "running": case "waiting": return "Not settled";
    case "not-billed": case "failed-not-billed": return "Not billed";
    case "own-key": return "Own key · not billed";
    case "failed-charged": return `${ledgerAmount(row)} · failed`;
    case "failed-unknown": return "Charge unknown";
    case "unpriced": return "—";
    default: return ledgerAmount(row);
  }
}
