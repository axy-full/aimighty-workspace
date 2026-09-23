import { currentTenant } from "./tenant";
import { creditCheck } from "./credits";
import { paidByPlatform, platformSpendSince } from "./platformSpend";
import type { VendorKeyName } from "./vendorKeys";
import { cycleBounds } from "./cycle";

export { paidByPlatform, platformSpendSince } from "./platformSpend";

/**
 * The walls around the platform's money.
 *
 * A workspace that signs up gets working engines at once, on the keys the
 * deployment holds. Two things stand between that and rendering the
 * platform dry: its CREDIT balance (lib/credits.ts — the primary wall, what
 * it bought or was granted) and, optionally, a monthly cap in dollars
 * (PLATFORM_ALLOWANCE_USD, or a per-workspace figure set on /admin). Both
 * are checked before every paid call; a vendor the workspace holds its own
 * key for is not the platform's money and passes both.
 */
export function defaultAllowanceUsd(): number | null {
  const raw = process.env.PLATFORM_ALLOWANCE_USD;
  if (raw == null || raw.trim() === "") return null;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

export { vendorKeyNameFor, renderKeyNameFor } from "./platformSpend";

/** The workspace's monthly cap on the platform's keys, or null when none applies. */
export function allowanceUsd(): number | null {
  const ws = currentTenant()?.workspace;
  if (!ws || ws.legacy || !ws.usesPlatformKeys) return null;
  return ws.allowanceUsd ?? defaultAllowanceUsd();
}

/**
 * Cycle-to-date spend that the platform paid for this workspace.
 *
 * The window comes from `lib/cycle.ts` rather than being walked back to the
 * 1st here. Same answer — anchored on the 1st, a cycle IS the calendar month,
 * and a test asserts that against the other implementation this replaces —
 * but there is one place that knows where a period begins now, which is what
 * §7A's "expire at cycle end" will need when the anchor stops being the 1st.
 */
export async function platformSpendThisMonth(): Promise<number> {
  return platformSpendSince(cycleBounds(1, Date.now()).start);
}

/**
 * The gate. Call before spending on `vendor`; a refusal carries the
 * sentence to show and the status to send.
 */
export async function allowanceCheck(vendor: VendorKeyName, estUsd = 0, engine?: string | null): Promise<
  { ok: true } | { ok: false; status: number; error: string }
> {
  const credit = await creditCheck(vendor, estUsd, engine);
  if (!credit.ok) return credit;
  if (!paidByPlatform(vendor)) return { ok: true };
  const cap = allowanceUsd();
  if (cap == null) return { ok: true };
  const spent = await platformSpendThisMonth();
  if (spent >= cap || spent + Math.max(0, estUsd) > cap) {
    return {
      ok: false, status: 429,
      error: `This workspace has used $${spent.toFixed(2)} of its $${cap.toFixed(2)} monthly cap on the platform's engines. ` +
             `Ask management to raise it.`,
    };
  }
  return { ok: true };
}
