import { currentTenant } from "./tenant";
import { db } from "./db";
import { billedTo, type ProviderId } from "./providers";
import type { VendorKeyName } from "./vendorKeys";

/**
 * What the platform has paid for a workspace.
 *
 * A workspace on the platform's keys spends the platform's money for every
 * vendor it holds no key of its own for. This sums that spend from the
 * workspace's own tables — renders, prompt writing, identity training —
 * so the credit balance and the monthly allowance both read from one
 * source of truth rather than a second ledger that could drift.
 */
const PROVIDERS_OF: Record<VendorKeyName, ProviderId[]> = {
  ark: ["byteplus"], gemini: ["google"], gateway: ["vercel", "google"], fal: ["fal"], elevenlabs: ["elevenlabs"],
};

/** Does this vendor's bill land on the platform for the current workspace? */
export function paidByPlatform(name: VendorKeyName): boolean {
  const ws = currentTenant()?.workspace;
  if (!ws || ws.legacy || !ws.usesPlatformKeys) return false;
  return !ws.keys[name];
}

/** Platform-paid spend since a moment, in dollars of vendor cost. */
export async function platformSpendSince(sinceMs: number): Promise<number> {
  const ws = currentTenant()?.workspace;
  if (!ws) return 0;
  const vendors = (Object.keys(PROVIDERS_OF) as VendorKeyName[]).filter((n) => !ws.keys[n]);
  const providers = [...new Set(vendors.flatMap((n) => PROVIDERS_OF[n]))];
  if (!providers.length) return 0;
  const marks = providers.map(() => "?").join(",");
  const rs = await db().execute({
    sql: `SELECT COALESCE(SUM(COALESCE(cost_usd,0)+COALESCE(refine_cost_usd,0)),0) AS spend
          FROM generations
          WHERE created_at >= ? AND (deleted = 0 OR deleted IS NULL)
            AND COALESCE(billed_to, provider) IN (${marks})`,
    args: [sinceMs, ...providers],
  });
  let spend = Number((rs.rows[0] as Record<string, unknown>)?.spend ?? 0);
  if (!ws.keys.fal) {
    const ids = await db().execute({
      sql: `SELECT COALESCE(SUM(COALESCE(cost_usd,0)),0) AS spend FROM identities WHERE created_at >= ?`,
      args: [sinceMs],
    }).catch(() => null);
    spend += Number((ids?.rows[0] as Record<string, unknown> | undefined)?.spend ?? 0);
  }
  if (!ws.keys.gateway) {
    // Atomik's thinking and the idea writer: text spend through the gateway.
    const text = await db().execute({
      sql: `SELECT (SELECT COALESCE(SUM(COALESCE(text_cost_usd,0)),0) FROM atomik_chats WHERE deleted = 0 AND created_at >= ?)
                 + (SELECT COALESCE(SUM(cost_usd),0) FROM atomik_spend WHERE created_at >= ?) AS spend`,
      args: [sinceMs, sinceMs],
    }).catch(() => null);
    spend += Number((text?.rows[0] as Record<string, unknown> | undefined)?.spend ?? 0);
  }
  return spend;
}

/** The vendor key a provider's renders draw on. */
export function vendorKeyNameFor(provider: string): VendorKeyName {
  switch (provider) {
    case "byteplus": return "ark";
    case "google": return billedTo("google") === "vercel" ? "gateway" : "gemini";
    case "vercel": return "gateway";
    case "fal": return "fal";
    case "elevenlabs": return "elevenlabs";
    default: return "ark";
  }
}
