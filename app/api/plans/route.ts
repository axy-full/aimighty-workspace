import { NextResponse } from "next/server";
import { getPlatformLayer } from "@/lib/platform";
import {
  ANNUAL_DISCOUNT_PERCENT,
  billingConfiguration,
} from "@/lib/billingConfig";

export const dynamic = "force-dynamic";
export async function GET() {
  try {
    const layer = await getPlatformLayer();
    const billing = billingConfiguration();
    return NextResponse.json(
      {
        plans: layer.plans,
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
}
