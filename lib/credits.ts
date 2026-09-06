import { currentTenant, runInTenant, type TenantWorkspace } from "./tenant";
import { creditsGranted } from "./platform";
import { paidByPlatform, platformSpendSince } from "./platformSpend";
import { creditUsd, creditMarkup, usdToCredits, type CreditState } from "./creditTerms";
import type { VendorKeyName } from "./vendorKeys";

export type { CreditState } from "./creditTerms";

/**
 * A workspace's credit balance.
 *
 * Granted minus used. Grants are rows in the platform record (the welcome
 * grant at sign-up, whatever management adds on /admin); used is the
 * platform-paid spend read off the workspace's own tables, converted at
 * the credit terms. Nothing is written when a render finishes — the
 * balance is a sum, so it cannot drift from the ledger it is a view of.
 *
 * Credits apply to a workspace on the platform's keys. The studio's own
 * workspace and any workspace on its own keys spend dollars with their
 * vendors and have no balance here.
 */
export function creditsApply(ws: TenantWorkspace | null | undefined): boolean {
  return Boolean(ws && !ws.legacy && ws.usesPlatformKeys);
}

export async function creditStateFor(ws: TenantWorkspace): Promise<CreditState | null> {
  if (!creditsApply(ws)) return null;
  const [granted, usedUsd] = await Promise.all([
    creditsGranted(ws.id),
    runInTenant(ws, () => platformSpendSince(0)),
  ]);
  const used = usdToCredits(usedUsd);
  return { creditUsd: creditUsd(), markup: creditMarkup(), granted, used, balance: granted - used };
}

export async function creditState(): Promise<CreditState | null> {
  const ws = currentTenant()?.workspace;
  return ws ? creditStateFor(ws) : null;
}

/** Credits, written for a sentence: one decimal under ten, whole above. */
export function fmtCredits(n: number): string {
  if (n > 0 && n < 0.05) return "<0.1";
  const v = Math.abs(n) < 10 ? Math.round(n * 10) / 10 : Math.round(n);
  return v.toLocaleString("en-US");
}

/**
 * The wall. Before spending on `vendor` from the platform's key, the
 * workspace must have credits — and enough of them when the estimate is
 * known.
 */
export async function creditCheck(vendor: VendorKeyName, estUsd = 0): Promise<
  { ok: true } | { ok: false; status: number; error: string }
> {
  const ws = currentTenant()?.workspace;
  if (!creditsApply(ws) || !paidByPlatform(vendor)) return { ok: true };
  const st = await creditStateFor(ws!);
  if (!st) return { ok: true };
  const need = usdToCredits(Math.max(0, estUsd));
  if (st.balance <= 0 || st.balance < need) {
    return {
      ok: false, status: 402,
      error: `Out of credits — ${fmtCredits(Math.max(0, st.balance))} left${need > 0 ? ` and this needs ${fmtCredits(need)}` : ""}. ` +
             `Ask management for more, or add your own key for the vendor under Settings › Engines & keys.`,
    };
  }
  return { ok: true };
}
