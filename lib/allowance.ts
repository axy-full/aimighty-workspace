import { currentTenant } from "./tenant";
import { db } from "./db";
import { billedTo, type ProviderId } from "./providers";
import type { VendorKeyName } from "./vendorKeys";

/**
 * What a workspace may spend on the platform's keys.
 *
 * A workspace that signs up gets working engines at once, on the keys the
 * deployment holds — which means the platform's money. This is the wall
 * around that: a monthly allowance in dollars, checked before every paid
 * call, so a new workspace can render on day one and nobody can render the
 * platform dry. A vendor the workspace holds its own key for is not the
 * platform's money and is not counted.
 *
 * The number comes from the workspace row (set on /admin) or, failing that,
 * PLATFORM_ALLOWANCE_USD. The studio's own workspace and any workspace on
 * its own keys have no allowance to check.
 */
export function defaultAllowanceUsd(): number {
  const n = Number(process.env.PLATFORM_ALLOWANCE_USD ?? 25);
  return Number.isFinite(n) && n >= 0 ? n : 25;
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

const PROVIDERS_OF: Record<VendorKeyName, ProviderId[]> = {
  ark: ["byteplus"], gemini: ["google"], gateway: ["vercel", "google"], fal: ["fal"], elevenlabs: ["elevenlabs"],
};

/** Does this vendor's bill land on the platform for the current workspace? */
export function paidByPlatform(name: VendorKeyName): boolean {
  const ws = currentTenant()?.workspace;
  if (!ws || ws.legacy || !ws.usesPlatformKeys) return false;
  return !ws.keys[name];
}

/** The workspace's monthly allowance on the platform's keys, or null when none applies. */
export function allowanceUsd(): number | null {
  const ws = currentTenant()?.workspace;
  if (!ws || ws.legacy || !ws.usesPlatformKeys) return null;
  return ws.allowanceUsd ?? defaultAllowanceUsd();
}

/** Month-to-date spend that the platform paid for this workspace. */
export async function platformSpendThisMonth(): Promise<number> {
  const ws = currentTenant()?.workspace;
  if (!ws) return 0;
  const vendors = (Object.keys(PROVIDERS_OF) as VendorKeyName[]).filter((n) => !ws.keys[n]);
  const providers = [...new Set(vendors.flatMap((n) => PROVIDERS_OF[n]))];
  if (!providers.length) return 0;
  const start = new Date();
  start.setUTCDate(1); start.setUTCHours(0, 0, 0, 0);
  const marks = providers.map(() => "?").join(",");
  const rs = await db().execute({
    sql: `SELECT COALESCE(SUM(COALESCE(cost_usd,0)+COALESCE(refine_cost_usd,0)),0) AS spend
          FROM generations
          WHERE created_at >= ? AND (deleted = 0 OR deleted IS NULL)
            AND COALESCE(billed_to, provider) IN (${marks})`,
    args: [start.getTime(), ...providers],
  });
  let spend = Number((rs.rows[0] as Record<string, unknown>)?.spend ?? 0);
  if (!ws.keys.fal) {
    const ids = await db().execute({
      sql: `SELECT COALESCE(SUM(COALESCE(cost_usd,0)),0) AS spend FROM identities WHERE created_at >= ?`,
      args: [start.getTime()],
    }).catch(() => null);
    spend += Number((ids?.rows[0] as Record<string, unknown> | undefined)?.spend ?? 0);
  }
  return spend;
}

/**
 * The gate. Call before spending on `vendor`; a refusal carries the
 * sentence to show and the status to send.
 */
export async function allowanceCheck(vendor: VendorKeyName, estUsd = 0): Promise<
  { ok: true } | { ok: false; status: number; error: string }
> {
  if (!paidByPlatform(vendor)) return { ok: true };
  const cap = allowanceUsd();
  if (cap == null) return { ok: true };
  const spent = await platformSpendThisMonth();
  if (spent >= cap || spent + Math.max(0, estUsd) > cap) {
    return {
      ok: false, status: 429,
      error: `This workspace has used $${spent.toFixed(2)} of its $${cap.toFixed(2)} monthly allowance on the platform's engines. ` +
             `Add your own key for the vendor under Settings › Engines & keys, or ask management to raise the allowance.`,
    };
  }
  return { ok: true };
}
