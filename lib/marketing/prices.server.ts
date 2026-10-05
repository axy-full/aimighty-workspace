import { getPlatformLayer } from "@/lib/platform";
import { DEFAULT_PLANS, type PlanDef } from "@/lib/plans";
import { packs, pricePack, type Pack } from "@/lib/packs";
import { billCreditsWith, marginFor, signupCredits } from "@/lib/creditTerms";
import { ANNUAL_DISCOUNT_PERCENT } from "@/lib/billingConfig";
import { buildRateTable } from "@/lib/rateTable.server";
import { charged, estimateImage, estimateVideo, writerCall, type RateTable } from "@/lib/rateTable";
import { estimateComposerVideo } from "@/lib/composerQuote";
import { costUsd, getModel } from "@/lib/models";
import { TRAIN_STEPS, trainCostUsd } from "@/lib/identityPricing";

/**
 * Every figure the public site states, computed from the same sources the
 * app bills from: plans from the platform layer, the Invite grant from its
 * cap, packs from lib/packs, and each rate from the credit rate table with
 * the composer's own estimator. Nothing here is typed in by hand, so the site
 * cannot drift from what a workspace is charged. A figure that cannot be
 * computed is null and the page says "Live quote" rather than guess.
 *
 * One input is fixed: the price of a credit. The site states the published
 * rate card, CLAUDE.md § Pricing, at its public price, so it never moves with
 * the unit the ledger counts in on a given day. Every credit figure and pack
 * price below is computed at SITE_CREDIT_USD; plans, the Invite grant and the
 * margin table still come from where the app reads them.
 */

/** The public price of a credit (CLAUDE.md § Pricing: "1 credit = US$0.10, fixed"). */
export const SITE_CREDIT_USD = 0.10;

export type RateRow = { action: string; spec: string; credits: number | null };
export type EngineQuote = { id: string; name: string; short: string; credits: number | null; basis: string };
export type SitePrices = {
  perCredit: number;
  annualDiscountPercent: number;
  plans: PlanDef[];
  inviteCredits: number;
  packs: Pack[];
  rateCard: RateRow[];
  engines: Record<string, EngineQuote>;
  /** The hero's Generate button: Seedance 2.5, 5 s, 1080p, 16:9, audio. */
  hero: EngineQuote;
};

export const SEEDANCE_25 = "dreamina-seedance-2-5-260628";
export const SEEDANCE_20 = "dreamina-seedance-2-0-260128";
export const KLING_STD = "fal-ai/kling-video/v3/standard";
export const KLING_PRO = "fal-ai/kling-video/v3/pro";
export const NANO_PRO = "gemini-3-pro-image";
export const NANO_2 = "gemini-3.1-flash-image";
export const GPT_IMAGE = "gpt-image-2.5-flare";
export const TOPAZ = "topaz/upscale/video/creative";

const video = (t: RateTable, id: string, resolution: string, seconds: number, audio: boolean) =>
  charged(t, estimateComposerVideo(t, id, resolution, "16:9", seconds, audio, []));
/* Per-second post engines (the upscaler) have no frame tokens to count. */
const perSecond = (t: RateTable, id: string, resolution: string, seconds: number) =>
  charged(t, estimateVideo(t, id, resolution, seconds, null, costUsd));
const still = (t: RateTable, id: string, size: string) => charged(t, estimateImage(t, id, size));

function quote(id: string, credits: number | null, basis: string): EngineQuote {
  const model = getModel(id);
  return { id, name: model.label, short: model.short, credits, basis };
}

async function planLayer(): Promise<{ plans: PlanDef[]; inviteCredits: number }> {
  try {
    const layer = await getPlatformLayer();
    return { plans: layer.plans?.length ? layer.plans : DEFAULT_PLANS, inviteCredits: layer.caps.signupCredits ?? signupCredits() };
  } catch {
    /* No platform database (a build without one): the launch defaults. */
    return { plans: DEFAULT_PLANS, inviteCredits: signupCredits() };
  }
}

/** Everything priced in credits or pack dollars: pure, at the public rate. */
export type SiteRates = Omit<SitePrices, "plans" | "inviteCredits" | "annualDiscountPercent">;

export function siteRates(): SiteRates {
  const t = buildRateTable("cr", SITE_CREDIT_USD);

  /* The prompt writer: the dearest text model, so the card never under-states it. */
  const writer = Object.keys(t.text).reduce<number | null>((max, id) => {
    const each = writerCall(t, id, 400);
    return each == null ? max : Math.max(max ?? 0, each);
  }, null);
  let training: number | null = null;
  try { training = billCreditsWith(trainCostUsd(), marginFor("identity-training"), SITE_CREDIT_USD); } catch { training = null; }

  const hero = quote(SEEDANCE_25, video(t, SEEDANCE_25, "1080p", 5, true), "5 s · 1080p");
  const gptLow = still(t, GPT_IMAGE, "Low");
  const gptHigh = still(t, GPT_IMAGE, "High");

  return {
    perCredit: SITE_CREDIT_USD,
    /* The pack table the app sells (CREDIT_PACKS may override it), priced at the public rate. */
    packs: packs().map(({ id, label, credits, bonus }) => pricePack({ id, label, credits, bonus }, SITE_CREDIT_USD)),
    rateCard: [
      { action: "Standard still", spec: "Nano Banana 2 · 512", credits: still(t, NANO_2, "512") },
      { action: "Keyframe still", spec: "Nano Banana Pro · 1K", credits: still(t, NANO_PRO, "1K") },
      { action: "Kling 3.0 Standard", spec: "5 s · 1080p", credits: video(t, KLING_STD, "1080p", 5, false) },
      { action: "Kling 3.0 Standard", spec: "5 s · 1080p · audio", credits: video(t, KLING_STD, "1080p", 5, true) },
      { action: "Kling 3.0 Pro", spec: "5 s · 1080p · audio", credits: video(t, KLING_PRO, "1080p", 5, true) },
      { action: "Seedance 2.5", spec: "5 s · 720p", credits: video(t, SEEDANCE_25, "720p", 5, true) },
      { action: "Seedance 2.0", spec: "5 s · 1080p", credits: video(t, SEEDANCE_20, "1080p", 5, false) },
      { action: "Seedance 2.5", spec: "5 s · 1080p", credits: hero.credits },
      { action: "Topaz upscale", spec: "5 s · 1080p", credits: perSecond(t, TOPAZ, "1080p", 5) },
      { action: "Topaz upscale", spec: "5 s · 4K", credits: perSecond(t, TOPAZ, "4k", 5) },
      { action: "Identity training", spec: `${TRAIN_STEPS.toLocaleString("en-US")} steps`, credits: training },
      { action: "Prompt enhancement", spec: "per prompt", credits: charged(t, writer) },
    ],
    engines: {
      [SEEDANCE_25]: quote(SEEDANCE_25, video(t, SEEDANCE_25, "720p", 5, true), "5 s · 720p"),
      [SEEDANCE_20]: quote(SEEDANCE_20, video(t, SEEDANCE_20, "1080p", 5, false), "5 s · 1080p"),
      [KLING_PRO]: quote(KLING_PRO, video(t, KLING_PRO, "1080p", 5, true), "5 s · 1080p · audio"),
      [NANO_PRO]: quote(NANO_PRO, still(t, NANO_PRO, "1K"), "1K keyframe"),
      [NANO_2]: quote(NANO_2, still(t, NANO_2, "512"), "512 still"),
      [GPT_IMAGE]: {
        ...quote(GPT_IMAGE, gptLow, "Low to High"),
        basis: gptLow != null && gptHigh != null && gptHigh !== gptLow ? `to ${gptHigh} cr · Low to High` : "a still",
      },
      [TOPAZ]: quote(TOPAZ, perSecond(t, TOPAZ, "4k", 5), "5 s · to 4K"),
    },
    hero,
  };
}

export async function sitePrices(): Promise<SitePrices> {
  const { plans, inviteCredits } = await planLayer();
  return { ...siteRates(), annualDiscountPercent: ANNUAL_DISCOUNT_PERCENT, plans, inviteCredits };
}
