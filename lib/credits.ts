import { currentTenant, type TenantWorkspace } from "./tenant";
import { paidByPlatform } from "./platformSpend";
import { billCreditsWith, creditUsd, creditsFigure, floorDeci, fromDeci, type CreditState } from "./creditTerms";
import { creditsFor, type EstimateTerms } from "./billingTerms";
import type { VendorKeyName } from "./vendorKeys";
import { billingStateFor } from "./billingLedger";

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
  const { creditUsd, granted, used, balance } = (await billingStateFor(ws.id)).credits;
  return { creditUsd, granted, used, balance };
}

export async function creditState(): Promise<CreditState | null> {
  const ws = currentTenant()?.workspace;
  return ws ? creditStateFor(ws) : null;
}

/**
 * The credits a quote states and its approval ceiling (`maxCredits`) is
 * checked in.
 *
 * A workspace billed in credits is quoted what it will be billed. A workspace
 * on its own keys is billed nothing in credits — its vendors bill it in
 * dollars, which its quote states — and a credit count at the platform's
 * rate beside those dollars would state the margin. Its approval counts the
 * same dollars in credits (to a tenth) at the price of a credit instead, so the
 * ceiling still holds and says nothing else.
 *
 * `engine` is the margin key, or the exact terms the job's reservation will
 * charge (lib/billingTerms.ts currentBillingTerms): given those, the quote is
 * the figure the reservation and the settlement charge for this estimate.
 */
export function quotedCredits(usd: number, engine?: EstimateTerms): number {
  return creditsApply(currentTenant()?.workspace) ? creditsFor(usd, engine) : billCreditsWith(usd, 1, creditUsd());
}

/** Credits, written for a sentence: to a tenth, one decimal only when it is not zero; a trace reads "<0.1". */
export function fmtCredits(n: number): string {
  if (n > 0 && n < 0.05) return "<0.1";
  return creditsFigure(n);
}

/**
 * The wall. Before spending on `vendor` from the platform's key, the
 * workspace must have credits — and enough of them when the estimate is
 * known. `engine`, as for quotedCredits: the margin key, or the terms the
 * reservation will charge.
 */
export type CreditVerdict = { ok: true } | { ok: false; status: number; error: string };

export async function creditCheck(vendor: VendorKeyName, estUsd = 0, engine?: EstimateTerms): Promise<CreditVerdict> {
  if (!creditsApply(currentTenant()?.workspace) || !paidByPlatform(vendor)) return { ok: true };
  const state = await creditState();
  if (!state) return { ok: true };
  const need = creditsFor(estUsd, engine);
  if (state.balance <= 0 || state.balance < need) {
    /* What is left, to the tenth a charge is made in: 0.5 left is not "0 left". */
    const left = Math.max(0, fromDeci(floorDeci(state.balance)));
    return {
      ok: false, status: 402,
      error: need > 0 && left > 0
        ? `Out of credits: this needs ${creditsFigure(need)}, ${creditsFigure(left)} left. Top up in Settings › Credits.`
        : `Out of credits (${creditsFigure(left)} left). Top up in Settings › Credits.`,
    };
  }
  return { ok: true };
}
