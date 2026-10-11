import { DEFAULT_PLANS, BUSINESS, ENTERPRISE, cycleCredits, plansIn, type PlanDef } from "@/lib/plans";

/**
 * The plans the new interface shows (prototype v14: Settings › Credits & billing and the new-workspace "Choose a plan" step), from the
 * owner's plans in lib/plans.ts (the one place their names, credits and prices live), written nowhere else. Display only: checkout
 * grants credits only from a verified payment (docs/subscribed-workspaces.md).
 *
 *  - Individual: Explore, Create and Master, each with its one line.
 *  - Business: one shared workspace, priced per seat, credits pooled across seats, one level per workspace; a seats stepper shows the total.
 *  - Enterprise: "Get in touch", no price.
 */
export type IndividualCard = { id: string; name: string; credits: number; priceUsd: number; blurb: string | null };
export type BusinessLevel = { id: string; name: string; perSeatUsd: number; perSeatCredits: number };

const individual = plansIn(DEFAULT_PLANS, "individual");
const levels = plansIn(DEFAULT_PLANS, "business");

export const INDIVIDUAL_CARDS: readonly IndividualCard[] = Object.freeze(individual.map((plan): IndividualCard => ({ id: plan.id, name: plan.label, credits: plan.includedCredits, priceUsd: plan.priceUsd, blurb: plan.blurb })));
export const BUSINESS_LEVELS: readonly BusinessLevel[] = Object.freeze(levels.map((plan): BusinessLevel => ({ id: plan.id, name: plan.label, perSeatUsd: plan.priceUsd, perSeatCredits: plan.includedCredits })));
/** The least a seat costs a month: the heading's "from". */
export const BUSINESS_FROM_USD: number = Math.min(...levels.map((plan) => plan.priceUsd));
export { BUSINESS, ENTERPRISE };

/** A business level at a number of seats: what it comes to a month, and the credits pooled across the seats. */
export function seatTotal(level: Pick<PlanDef, "priceUsd" | "includedCredits" | "perSeat">, seats: number): { seats: number; usd: number; credits: number } {
  const n = Math.min(BUSINESS.seats.max, Math.max(BUSINESS.seats.min, Math.floor(Number.isFinite(seats) ? seats : BUSINESS.seats.min)));
  return { seats: n, usd: level.priceUsd * n, credits: cycleCredits(level, n) };
}

/**
 * What "a hero take" means on a card: Make's default video (lib/shell/make-price.ts MAKE_MODEL_PREFERENCE, MAKE_PICKS)
 * at five seconds. Its price is never written here: the card asks the engines route for it (GET /api/workbench/engines).
 */
export const HERO_TAKE = Object.freeze({ model: "dreamina-seedance-2-5-260628", resolution: "1080p", ratio: "16:9", duration: 5 });
