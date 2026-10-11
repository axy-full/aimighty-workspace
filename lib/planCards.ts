/**
 * The plan cards the new interface shows (docs/redesign-plan.md, decision 7), from the owner's final plans in lib/plans.ts.
 * Nothing in billing reads this file: checkout, subscriptions and the credits a cycle grants stay on lib/plans.ts rows.
 *
 * Figures: the owner's plans (CLAUDE.md § Pricing).
 */
import { DEFAULT_PLANS, plansIn } from "@/lib/plans";

export type PlanCard = {
  id: string;
  name: string;
  /** Credits a month; on a Business card, a seat's at its lowest level. */
  credits: number;
  /** Dollars a month; on a Business card, a seat's at its lowest level ("from"). */
  priceUsd: number;
  /** A Business card is priced a seat, from its lowest level, and its credits are pooled across seats. */
  perSeat: boolean;
  /** The card's second line. "hero-takes": how many hero takes the credits buy, counted from a live quote of HERO_TAKE. */
  line: "hero-takes" | string;
};

/**
 * The cards the new interface shows are the owner's plans (lib/plans.ts, the one place their names, credits and prices live),
 * read from there and written nowhere else: one person's Explore, Create and Master, then Business. Display only: checkout
 * grants credits only from a verified payment (docs/subscribed-workspaces.md).
 */
const individual = plansIn(DEFAULT_PLANS, "individual");
const levels = plansIn(DEFAULT_PLANS, "business");
const lowest = levels.reduce((a, b) => (b.priceUsd < a.priceUsd ? b : a), levels[0]);
export const PLAN_CARDS: readonly PlanCard[] = Object.freeze([
  ...individual.map((plan): PlanCard => ({ id: plan.id, name: plan.label, credits: plan.includedCredits, priceUsd: plan.priceUsd, perSeat: false, line: "hero-takes" })),
  { id: "business", name: "Business", credits: lowest.includedCredits, priceUsd: lowest.priceUsd, perSeat: true, line: "One shared workspace · credits pooled across seats" },
]);

/**
 * What "a hero take" means on a card: Make's default video (lib/shell/make-price.ts MAKE_MODEL_PREFERENCE, MAKE_PICKS)
 * at five seconds. Its price is never written here: the card asks the engines route for it (GET /api/workbench/engines).
 */
export const HERO_TAKE = Object.freeze({ model: "dreamina-seedance-2-5-260628", resolution: "1080p", ratio: "16:9", duration: 5 });
