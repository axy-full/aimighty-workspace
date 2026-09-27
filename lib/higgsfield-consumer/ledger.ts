/**
 * The connected account's own credit ledger, read for one job.
 *
 * The account's help centre is plain that a failed generation's status does
 * not settle its charge: credits "usually" come back automatically, "specific
 * models might not refund credits for failed generations", NSFW refunds hold
 * "for most models", and Grok generations are "charged the moment they
 * start" — while "every charge and refund is recorded" on the account's usage
 * ledger. Its MCP lists that ledger through `transactions` ("the user's credit
 * transactions (spend/refund/grant/deduct), newest first").
 *
 * No `transactions` page has been recorded from life (only free reads may be,
 * and none was taken for this), so an entry is read strictly and fails
 * closed: it counts only when it names the job's exact id somewhere in it AND
 * carries the tool's own word for its kind — `refund` or `spend` — as a
 * value. Its amount is read only from a plainly numeric amount field. An
 * entry naming another job, both kinds, or no kind is ignored, and a job the
 * page does not name stays unknown ("Higgsfield didn't say"). Other jobs'
 * entries are never kept, returned or shown: the account is an engine, not
 * a library.
 *
 * Pure: mcp.ts reads the page, this reads the page for one job.
 */
import type { AccountLedger } from "../providerOutcome";

const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** The transactions tool's own words for a charge and its return. */
const REFUND = new Set(["refund", "refunded"]);
const SPEND = new Set(["spend", "spent"]);
const AMOUNT_KEYS = ["amount", "credits", "credit_amount", "value", "delta"] as const;
/** How many entries of one page are read, and how deep an entry is searched for the job's id. */
export const LEDGER_PAGE = 50;
const DEPTH = 3;

/** The transactions list in a reply: `items`, `transactions`, `data` or `results`, or the reply itself. */
export function ledgerEntries(reply: unknown): unknown[] {
  if (Array.isArray(reply)) return reply.slice(0, LEDGER_PAGE);
  if (!record(reply)) return [];
  const list = [reply.items, reply.transactions, reply.data, reply.results].find(Array.isArray) as unknown[] | undefined;
  return (list ?? []).slice(0, LEDGER_PAGE);
}

/** Whether the job's exact id appears as a value anywhere in the entry (bounded depth). */
function names(value: unknown, jobId: string, depth = 0): boolean {
  if (typeof value === "string") return value.toLowerCase() === jobId;
  if (depth >= DEPTH) return false;
  if (Array.isArray(value)) return value.slice(0, 20).some((item) => names(item, jobId, depth + 1));
  if (record(value)) return Object.values(value).slice(0, 40).some((item) => names(item, jobId, depth + 1));
  return false;
}

/** "refund", "spend", or null: the entry's own top-level word for its kind, when it has exactly one. */
function kindOf(entry: Record<string, unknown>): "refund" | "spend" | null {
  const words = Object.values(entry).filter((v): v is string => typeof v === "string").map((v) => v.trim().toLowerCase());
  const refund = words.some((w) => REFUND.has(w)), spend = words.some((w) => SPEND.has(w));
  return refund === spend ? null : refund ? "refund" : "spend";
}

/** The entry's credit amount, as a positive number, from the one numeric amount field it carries. */
function amountOf(entry: Record<string, unknown>): number | null {
  const found = AMOUNT_KEYS.map((key) => entry[key]).filter((v): v is number => typeof v === "number" && Number.isFinite(v));
  const unique = [...new Set(found.map((n) => Math.abs(n)))];
  return unique.length === 1 && unique[0] > 0 && unique[0] <= 1e9 ? unique[0] : null;
}

/**
 * What one page of the account's ledger says about one job, or null when no
 * entry names it. Several entries of a kind are summed (a batch of one job
 * refunded in parts); an amount the page does not state stays null.
 */
export function accountLedgerFor(reply: unknown, providerJobId: string): AccountLedger | null {
  if (!UUID.test(providerJobId)) return null;
  const jobId = providerJobId.toLowerCase();
  let refund = false, spend = false, refunded: number | null = 0, spent: number | null = 0;
  for (const entry of ledgerEntries(reply)) {
    if (!record(entry) || !names(entry, jobId)) continue;
    const kind = kindOf(entry);
    if (!kind) continue;
    const amount = amountOf(entry);
    if (kind === "refund") { refund = true; refunded = refunded === null || amount === null ? null : refunded + amount; }
    else { spend = true; spent = spent === null || amount === null ? null : spent + amount; }
  }
  if (!refund && !spend) return null;
  return { refund, spend, refunded: refund ? refunded : null, spent: spend ? spent : null };
}
