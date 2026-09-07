import type { TopupRequest } from "./topups";

/**
 * How a pack gets paid for.
 *
 * "manual" is what ships now: the request lands in the platform's queue,
 * management takes payment its own way and adds the credits, which
 * releases anything held. A card provider slots in here later —
 * startCheckout returns a URL to send the person to, and the webhook it
 * brings approves the same request — without the screen changing.
 */
export type PaymentProvider = "manual" | "stripe" | "razorpay";

export function paymentProvider(): PaymentProvider {
  const v = process.env.PAYMENT_PROVIDER;
  return v === "stripe" || v === "razorpay" ? v : "manual";
}

export type Checkout = { kind: "queued" } | { kind: "redirect"; url: string };

export async function startCheckout(req: TopupRequest): Promise<Checkout> {
  const provider = paymentProvider();
  if (provider === "manual") return { kind: "queued" };
  throw new Error(`Card checkout through ${provider} is not wired yet (${req.packId}).`);
}
