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
import { creditsApply } from "@/lib/credits";
import { effectiveModels } from "@/lib/defaultModels";
import type { RateGroup } from "@/lib/mediaReach";
import { paidFromBalance, rateCard, workspaceReach } from "@/lib/workbench/media-reach";

export const dynamic = "force-dynamic";
export const GET = withTenant(async function GET() {
  const auth = await requireSession();
  if (auth.response) return auth.response;
  const workspace = requireTenant();
  const [state, layer] = await Promise.all([
    billingStateFor(workspace.id),
    getPlatformLayer(),
  ]);
  /* The balance as takes, at this workspace's usual settings (its own recent
     takes) or its default engines, and the rate card those figures trace to —
     both limited to engines its credits actually pay for. Credit workspaces
     only: one billed in dollars on its own keys has no balance to translate.
     Best effort, each on its own: billing still answers when a translation
     cannot be made, and the rate card (catalogue only) survives a failed read
     of the workspace's takes. */
  const inCredits = creditsApply(workspace);
  const reach = inCredits
    ? await effectiveModels()
        .then((models) => workspaceReach(state.credits.balance, models, paidFromBalance))
        .catch(() => null)
    : null;
  let rates: RateGroup[] | null = null;
  try { rates = inCredits ? rateCard(paidFromBalance) : null; } catch { rates = null; }
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
      reach,
      rates,
    },
    { headers: { "Cache-Control": "no-store" } },
  );
});
