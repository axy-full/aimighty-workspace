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
 * keyed by the paid attempt, so the monthly cap can merge historical
 * product records with current meter reservations without counting twice.
 */
const PROVIDERS_OF: Record<VendorKeyName, ProviderId[]> = {
  ark: ["byteplus"], gemini: ["google"], gateway: ["vercel", "google"], fal: ["fal"], elevenlabs: ["elevenlabs"], higgsfield: ["higgsfield"],
};

/** Does this vendor's bill land on the platform for the current workspace? */
export function paidByPlatform(name: VendorKeyName): boolean {
  const ws = currentTenant()?.workspace;
  if (!ws || ws.legacy || !ws.usesPlatformKeys) return false;
  return !ws.keys[name];
}

/** Historical product costs, keyed by paid attempt rather than its parent chat/identity. */
export async function platformSpendRecordsSince(sinceMs: number): Promise<Map<string, number>> {
  const records = new Map<string, number>();
  const ws = currentTenant()?.workspace;
  if (!ws) return records;
  const vendors = (Object.keys(PROVIDERS_OF) as VendorKeyName[]).filter((n) => !ws.keys[n]);
  const providers = [...new Set(vendors.flatMap((n) => PROVIDERS_OF[n]))];
  if (!providers.length) return records;
  const marks = providers.map(() => "?").join(",");
  const rs = await db().execute({
    sql: `SELECT id, COALESCE(cost_usd,0)+COALESCE(refine_cost_usd,0) AS cost
          FROM generations
          WHERE created_at >= ?
            AND COALESCE(billed_to, provider) IN (${marks})`,
    args: [sinceMs, ...providers],
  });
  for (const row of rs.rows) records.set(String(row.id), Number(row.cost));
  const tables = new Set((await db().execute("SELECT name FROM sqlite_master WHERE type='table'")).rows.map((row) => String(row.name)));
  if (!ws.keys.higgsfield && tables.has("soul_identities")) {
    const identities = await db().execute({ sql: "SELECT id,cost_usd FROM soul_identities WHERE created_at>=?", args: [sinceMs] });
    for (const row of identities.rows) records.set(String(row.id), Number(row.cost_usd ?? 0));
  }
  if (!ws.keys.fal) {
    if (tables.has("identities")) {
      const identities = await db().execute({ sql: "SELECT * FROM identities WHERE created_at >= ?", args: [sinceMs] });
      for (const row of identities.rows) if (!row.training_run_id) records.set(String(row.id), Number(row.cost_usd ?? 0));
    }
    if (tables.has("identity_training_runs")) {
      const runs = await db().execute({ sql: "SELECT id,cost_usd FROM identity_training_runs WHERE created_at >= ?", args: [sinceMs] });
      for (const row of runs.rows) records.set(String(row.id), Number(row.cost_usd ?? 0));
    }
  }
  if (!ws.keys.gateway) {
    if (tables.has("atomik_messages")) {
      const messages = await db().execute({ sql: "SELECT id,cost_usd FROM atomik_messages WHERE role='assistant' AND created_at >= ?", args: [sinceMs] });
      for (const row of messages.rows) records.set(String(row.id), Number(row.cost_usd ?? 0));
    }
    if (tables.has("atomik_spend")) {
      const text = await db().execute({ sql: "SELECT id,cost_usd FROM atomik_spend WHERE created_at >= ?", args: [sinceMs] });
      for (const row of text.rows) records.set(String(row.id), Math.max(records.get(String(row.id)) ?? 0, Number(row.cost_usd ?? 0)));
    }
  }
  return records;
}

/** Recorded platform-paid spend since a moment, in dollars of vendor cost.
 * The final atomic reservation additionally merges live meter estimates. */
export async function platformSpendSince(sinceMs: number): Promise<number> {
  return [...(await platformSpendRecordsSince(sinceMs)).values()].reduce((sum, cost) => sum + cost, 0);
}

/** The vendor key a provider's renders draw on. */
export function vendorKeyNameFor(provider: string): VendorKeyName {
  switch (provider) {
    case "byteplus": return "ark";
    case "google": return billedTo("google") === "vercel" ? "gateway" : "gemini";
    case "vercel": return "gateway";
    case "fal": return "fal";
    case "elevenlabs": return "elevenlabs";
    case "higgsfield": return "higgsfield";
    default: return "ark";
  }
}
