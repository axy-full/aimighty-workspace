/**
 * The plan cards the new interface shows: Starter, Studio and Team (docs/redesign-plan.md, decision 7).
 *
 * PLACEHOLDERS, DISPLAY ONLY. This is the one place their names, credits and prices live; the screens read them from
 * here and write none of them (tests/unit/v12-no-credit-literals.spec.ts). Nothing in billing reads this file:
 * checkout, subscriptions and the included credits a cycle grants stay on today's plans (lib/plans.ts: Invite, Studio,
 * Agency, Production), untouched. Mapping these cards onto those plans, and their final figures, are the owner's
 * decision (NEEDS AKSHAY).
 *
 * Figures: the prototype's invite step (design/particl-prototype-12, docs/redesign/inventory.md § 8.4 and § 12).
 */

export const PLAN_CARDS_ARE_PLACEHOLDERS = true;

export type PlanCard = {
  id: "starter" | "studio" | "team";
  name: string;
  /** Credits a month (placeholder). */
  credits: number;
  /** Dollars a month (placeholder). */
  priceUsd: number;
  /** The card's second line. "hero-takes": how many hero takes the credits buy, counted from a live quote of HERO_TAKE. */
  line: "hero-takes" | string;
};

export const PLAN_CARDS: readonly PlanCard[] = Object.freeze([
  { id: "starter", name: "Starter", credits: 500, priceUsd: 50, line: "hero-takes" },
  { id: "studio", name: "Studio", credits: 2000, priceUsd: 180, line: "for a team" },
  { id: "team", name: "Team", credits: 6000, priceUsd: 500, line: "shared pool" },
]);

/**
 * What "a hero take" means on a card: Make's default video (lib/shell/make-price.ts MAKE_MODEL_PREFERENCE, MAKE_PICKS)
 * at five seconds. Its price is never written here: the card asks the engines route for it (GET /api/workbench/engines).
 */
export const HERO_TAKE = Object.freeze({ model: "dreamina-seedance-2-5-260628", resolution: "1080p", ratio: "16:9", duration: 5 });
