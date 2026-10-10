import { NextResponse } from "next/server";
import { requireSession, withTenant } from "@/lib/auth";
import { requireTenant } from "@/lib/tenant";
import { getPlatformLayer, planOf } from "@/lib/platform";
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
import { newInterfaceFor } from "@/lib/newInterface.server";

export const dynamic = "force-dynamic";
export const GET = withTenant(async function GET() {
  const auth = await requireSession();
  if (auth.response) return auth.response;
  const workspace = requireTenant();
  const [state, layer, plan] = await Promise.all([
    billingStateFor(workspace.id),
    getPlatformLayer(),
    /* The plan this workspace is on (paid, else the admin's label; null for none), for display only. Read only for the
       new interface's Credits & billing: planOf opens a ledger transaction, which today's screens don't need. */
    newInterfaceFor(workspace).then((on) => (on ? planOf(workspace) : null)).catch(() => null),
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
      plan: plan ? { id: plan.id, label: plan.label, includedCredits: plan.includedCredits } : null,
      credits: state.credits,
      cycles: state.cycles,
      reach,
      rates,
    },
    { headers: { "Cache-Control": "no-store" } },
  );
});
