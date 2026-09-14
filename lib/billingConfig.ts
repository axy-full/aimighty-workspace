import { paymentProvider } from "./payments";

export type BillingCadence = "monthly" | "annual";
export const ANNUAL_DISCOUNT_PERCENT = 20;
export function subscriptionPriceCents(
  monthlyUsd: number,
  cadence: BillingCadence,
) {
  return Math.round(
    monthlyUsd *
      100 *
      (cadence === "annual" ? 12 * (1 - ANNUAL_DISCOUNT_PERCENT / 100) : 1),
  );
}

/** Billing uses a configured origin, never a caller-supplied redirect host. */
export function billingOrigin(): string | null {
  try {
    const url = new URL(process.env.APP_ORIGIN ?? "");
    if (
      url.username ||
      url.password ||
      url.pathname !== "/" ||
      url.search ||
      url.hash
    )
      return null;
    const local =
      process.env.NODE_ENV !== "production" &&
      ["localhost", "127.0.0.1"].includes(url.hostname);
    return url.protocol === "https:" || (local && url.protocol === "http:")
      ? url.origin
      : null;
  } catch {
    return null;
  }
}

export function billingConfiguration() {
  if (paymentProvider() !== "stripe")
    return {
      configured: false,
      reason:
        "Online subscriptions are being connected. Your existing workspace remains available.",
    };
  if (
    !process.env.STRIPE_SECRET_KEY ||
    !process.env.STRIPE_WEBHOOK_SECRET ||
    !billingOrigin()
  ) {
    return {
      configured: false,
      reason:
        "Online billing is temporarily unavailable. Please try again later.",
    };
  }
  // A production domain must never sell a plan with a sandbox checkout.
  if (
    process.env.VERCEL_ENV === "production" &&
    !process.env.STRIPE_SECRET_KEY.startsWith("sk_live_")
  ) {
    return {
      configured: false,
      reason: "Online billing is awaiting activation.",
    };
  }
  return { configured: true, reason: null };
}
