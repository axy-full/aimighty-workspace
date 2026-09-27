/**
 * The analytics answer for a workspace billed in credits.
 *
 * `spend` in /api/analytics is what the vendors charged (cost_usd), and the
 * same rows carry the credits the workspace was billed. Shown side by side
 * they are the platform's margin per engine, which the SOW (§2, "Credits are
 * the unit") says is never shown: a credit workspace reads credits only. A
 * workspace on its own keys (legacy, or its own vendor accounts) pays those
 * dollars itself, so it keeps them.
 */
type Row = Record<string, unknown>;
const USD_KEYS = ["spend", "promptSpend"] as const;

function strip(row: unknown, keys: readonly string[]): unknown {
  if (!row || typeof row !== "object" || Array.isArray(row)) return row;
  const out: Row = { ...(row as Row) };
  for (const key of keys) delete out[key];
  return out;
}

export function withoutVendorCost<T extends Row>(payload: T): T {
  const out: Row = {};
  for (const [key, value] of Object.entries(payload)) {
    /* `credit` is the vendor top-up ledger (dollars in, dollars out). */
    if (key === "credit") continue;
    out[key] = Array.isArray(value) ? value.map((row) => strip(row, USD_KEYS)) : key === "totals" ? strip(value, USD_KEYS) : value;
  }
  return out as T;
}

/**
 * The same answer for a workspace on its own keys: its vendors' dollars, and
 * no `credits`. Those are the same dollars at the platform's rate — this
 * workspace is billed none of them — and beside the dollars they state the
 * margin as plainly as the dollars beside a credit workspace's credits would.
 */
export function withoutMarginCredits<T extends Row>(payload: T): T {
  const out: Row = {};
  for (const [key, value] of Object.entries(payload))
    out[key] = Array.isArray(value) ? value.map((row) => strip(row, ["credits"])) : key === "totals" ? strip(value, ["credits"]) : value;
  return out as T;
}

/**
 * A value with every key that names dollars taken out, at any depth.
 *
 * For the JSON a workspace billed in credits may read: a take's params keep
 * the working figures admission and settlement wrote there — an estimate, a
 * per-minute rate, a display price — and each is what a vendor charges. The
 * one dollar figure such a workspace may read, the price of a credit, is
 * never stored in a row, so nothing it needs is lost.
 */
export function withoutVendorDollars(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutVendorDollars);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .filter(([key]) => !/usd/i.test(key))
    .map(([key, item]) => [key, withoutVendorDollars(item)]));
}
