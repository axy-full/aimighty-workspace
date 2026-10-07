import { currentTenant, type TenantWorkspace } from "./tenant";
import { paidByPlatform } from "./platformSpend";
import { billCreditsWith, creditUsd, type CreditState } from "./creditTerms";
import { creditsFor, type EstimateTerms } from "./billingTerms";
import type { VendorKeyName } from "./vendorKeys";
import { billingStateFor } from "./billingLedger";
import { isHouseWorkspace } from "./houseWorkspace";

export type { CreditState } from "./creditTerms";

/**
 * Does this workspace pay in credits? Every one does, on its own credit
 * ledger, except the house workspace (lib/houseWorkspace.ts): it is never
 * billed in credits, so it has no balance, no grants and no credit walls, and
 * it reads its spend at the engines' cost.
 */
export function creditsApply(ws: TenantWorkspace | null | undefined): boolean {
  return Boolean(ws) && !isHouseWorkspace(ws);
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
 * A workspace billed in credits is quoted what it will be billed. The house
 * workspace is billed nothing in credits — its quote states the engines'
 * dollars — and a credit count at the platform's rate beside those dollars
 * would state the margin. Its approval counts the same dollars in whole
 * credits at the price of a credit instead, so the ceiling still holds and
 * says nothing else.
 *
 * `engine` is the margin key, or the exact terms the job's reservation will
 * charge (lib/billingTerms.ts currentBillingTerms): given those, the quote is
 * the figure the reservation and the settlement charge for this estimate.
 */
export function quotedCredits(usd: number, engine?: EstimateTerms): number {
  return creditsApply(currentTenant()?.workspace) ? creditsFor(usd, engine) : billCreditsWith(usd, 1, creditUsd());
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
 * known. `engine`, as for quotedCredits: the margin key, or the terms the
 * reservation will charge.
 */
export type CreditVerdict = { ok: true } | { ok: false; status: number; error: string };

export async function creditCheck(vendor: VendorKeyName, estUsd = 0, engine?: EstimateTerms, band = 1): Promise<CreditVerdict> {
  if (!creditsApply(currentTenant()?.workspace) || !paidByPlatform(vendor)) return { ok: true };
  const state = await creditState();
  if (!state) return { ok: true };
  /* A take that holds its ceiling needs its hold: its quote times its band (lib/cinemaHold.ts). */
  const need = creditsFor(estUsd, engine) * (Number.isInteger(band) && band > 1 ? band : 1);
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
