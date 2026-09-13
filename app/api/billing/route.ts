import { NextResponse } from "next/server";
import { requireSession, withTenant } from "@/lib/auth";
import { requireTenant } from "@/lib/tenant";
import { getPlatformLayer } from "@/lib/platform";
import { billingStateFor } from "@/lib/billingLedger";
import {
  billingConfiguration,
  ANNUAL_DISCOUNT_PERCENT,
} from "@/lib/billingConfig";
import { packs } from "@/lib/packs";

export const dynamic = "force-dynamic";
export const GET = withTenant(async function GET() {
  const auth = await requireSession();
  if (auth.response) return auth.response;
  const workspace = requireTenant();
  const [state, layer] = await Promise.all([
    billingStateFor(workspace.id),
    getPlatformLayer(),
  ]);
  return NextResponse.json(
    {
      ...billingConfiguration(),
      canManage: Boolean(auth.user.owner),
      workspace: { id: workspace.id, name: workspace.name },
      plans: layer.plans,
      packs: packs(),
      annualDiscountPercent: ANNUAL_DISCOUNT_PERCENT,
      subscription: state.subscription,
      credits: state.credits,
      cycles: state.cycles,
    },
    { headers: { "Cache-Control": "no-store" } },
  );
});
