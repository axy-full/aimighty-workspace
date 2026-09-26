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

function strip(row: unknown): unknown {
  if (!row || typeof row !== "object" || Array.isArray(row)) return row;
  const out: Row = { ...(row as Row) };
  for (const key of USD_KEYS) delete out[key];
  return out;
}

export function withoutVendorCost<T extends Row>(payload: T): T {
  const out: Row = {};
  for (const [key, value] of Object.entries(payload)) {
    /* `credit` is the vendor top-up ledger (dollars in, dollars out). */
    if (key === "credit") continue;
    out[key] = Array.isArray(value) ? value.map(strip) : key === "totals" ? strip(value) : value;
  }
  return out as T;
}
