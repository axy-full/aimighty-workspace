import { currentTenant, type TenantWorkspace } from "./tenant";
import { creditsGranted } from "./platform";
import { paidByPlatform } from "./platformSpend";
import { creditUsd, billCredits, type CreditState } from "./creditTerms";
import type { VendorKeyName } from "./vendorKeys";
import { creditsUsed } from "./meter";

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
  const [granted, used] = await Promise.all([creditsGranted(ws.id), creditsUsed(ws.id)]);
  return { creditUsd: creditUsd(), granted, used, balance: granted - used };
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
export type CreditVerdict = { ok: true } | { ok: false; status: number; error: string };

export async function creditCheck(vendor: VendorKeyName, estUsd = 0, engine?: string | null): Promise<CreditVerdict> {
  if (!creditsApply(currentTenant()?.workspace) || !paidByPlatform(vendor)) return { ok: true };
  const state = await creditState();
  if (!state) return { ok: true };
  const need = billCredits(estUsd, engine);
  if (state.balance <= 0 || state.balance < need) {
    const left = Math.max(0, Math.floor(state.balance));
    return {
      ok: false, status: 402,
      error: need > 0 && left > 0
        ? `Out of credits: this needs ${need}, ${left} left. Top up in Settings › Credits.`
        : `Out of credits (${left} left). Top up in Settings › Credits.`,
    };
  }
  return { ok: true };
}
