import {recoveryRoute} from '@/lib/recovery';
import { NextResponse } from "next/server";
import { getPlatformLayer } from "@/lib/platform";
import {
  ANNUAL_DISCOUNT_PERCENT,
  billingConfiguration,
} from "@/lib/billingConfig";
import { plansWithReach, rateCard, referenceTakes } from "@/lib/workbench/media-reach";

export const dynamic = "force-dynamic";
export const GET = recoveryRoute(async function GET() {
  try {
    const layer = await getPlatformLayer();
    const billing = billingConfiguration();
    /* Credits said as takes, priced by the composer's own quote at the
       platform's default engines and settings. Credits only: no rate, margin
       or vendor dollar is in this payload. */
    let reach: { plans: typeof layer.plans; reference: ReturnType<typeof referenceTakes> | null; rates: ReturnType<typeof rateCard> | null };
    try {
      const reference = referenceTakes(layer.models);
      reach = { plans: plansWithReach(layer.plans, reference), reference, rates: rateCard() };
    } catch {
      /* The plans still sell without the translation; the page says less. */
      reach = { plans: layer.plans, reference: null, rates: null };
    }
    return NextResponse.json(
      {
        ...reach,
        checkoutAvailable: billing.configured,
        reason: billing.reason,
        annualDiscountPercent: ANNUAL_DISCOUNT_PERCENT,
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch {
    return NextResponse.json(
      { error: "Plans are temporarily unavailable. Please try again." },
      { status: 503 },
    );
  }
});
