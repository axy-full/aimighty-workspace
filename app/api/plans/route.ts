import {recoveryRoute} from '@/lib/recovery';
import { NextResponse } from "next/server";
import { getPlatformLayer } from "@/lib/platform";
import {
  ANNUAL_DISCOUNT_PERCENT,
  billingConfiguration,
} from "@/lib/billingConfig";
import type { PlanDef } from "@/lib/plans";
import type { RateGroup, ReferenceTakes } from "@/lib/mediaReach";
import { plansWithReach, rateCard, referenceTakes } from "@/lib/workbench/media-reach";

export const dynamic = "force-dynamic";
export const GET = recoveryRoute(async function GET() {
  try {
    const layer = await getPlatformLayer();
    const billing = billingConfiguration();
    /* Credits said as takes: each plan's monthly credits at the platform's
       default engines and settings, and every engine's price per take, all
       from the composer's own quote. Credits only — no vendor dollar or
       margin is in this payload. Best effort: the plans still sell without
       the translation, and the page then says less. */
    let media: { plans: PlanDef[]; reference: ReferenceTakes | null; rates: RateGroup[] | null };
    try {
      const reference = referenceTakes(layer.models);
      media = { plans: plansWithReach(layer.plans, reference), reference, rates: rateCard() };
    } catch {
      media = { plans: layer.plans, reference: null, rates: null };
    }
    return NextResponse.json(
      {
        ...media,
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
