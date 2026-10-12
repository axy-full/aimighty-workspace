/**
 * Plans: what a workspace pays a month, and what that includes (SOW §7A).
 *
 * The word is PLAN, not tier. `tier` already means a resolution band in the
 * vendor rate table (`RateTier`, `TableTier`) and the code's meaning is the
 * older one — rule 5, one vocabulary, decided once.
 *
 * Credits only. §7A's panel inclusions were struck on 10 September
 * because a "standard panel" is not a unit this product has; a plan
 * differentiates on credits, and on the two counted ceilings Invite carries.
 *
 * **Invite's "250 cr once" is NOT an inclusion, and that is the whole reason
 * `includedCredits` is 0 for it.** Guardrail 1: "Free grant is one-time,
 * never recurring." The 250 is the welcome grant, already written once at
 * sign-up by `createWorkspace` and already marked `welcome` in the ledger.
 * Putting it here would grant it again every cycle and turn a signup gift
 * into a monthly stipend for every free workspace on the platform.
 *
 * Pure — no database — so the browser can validate what the console edits,
 * the same way the rest of the platform layer works.
 */

export type PlanId =
  | "invite" | "studio" | "agency" | "production"
  | "explore" | "create" | "master"
  | "business100" | "business250" | "business500";

/**
 * What a plan is for, on the pricing page and the plan cards:
 *  - `individual`: one person, a price a month for the credits it includes.
 *  - `business`: one shared workspace, a price per seat a month; each seat adds its included credits to one pool the whole
 *    workspace draws on. A workspace is on one business level at a time (no mixing levels).
 *  - `legacy`: Invite (the free default a new workspace starts on, with its one-time welcome grant) and the plans sold before
 *    the owner's final list (Studio, Agency, Production). A workspace on one still resolves it; none is offered.
 */
export type PlanGroup = "individual" | "business" | "legacy";

export type PlanDef = {
  id: PlanId;
  label: string;
  /** A month, in dollars. The one figure a plan is sold on. */
  priceUsd: number;
  /** Credits granted at each cycle. They do not roll over (§7A). */
  includedCredits: number;
  /** Productions a workspace may hold, or null for as many as it likes. */
  maxProductions: number | null;
  /** Members, or null for unlimited. A business plan's members are its seats, which checkout will count; nothing caps them here. */
  maxMembers: number | null;
  /** Where the plan is shown (see PlanGroup). */
  group: PlanGroup;
  /** Whether the public plan list offers it. A legacy plan is resolvable by a workspace that is on it, and never offered. */
  offered: boolean;
  /** A word on the card when the plan is the one most people take, or null. */
  badge: string | null;
  /** The card's one line (prototype v14), or null. */
  blurb: string | null;
  /** A business plan is sold per seat a month: `priceUsd` and `includedCredits` are for one seat. */
  perSeat: boolean;
};

export const PLAN_IDS: readonly PlanId[] = [
  "invite", "studio", "agency", "production",
  "explore", "create", "master", "business100", "business250", "business500",
];

/**
 * The shipped plans. The owner's final list (display only; checkout is later) is Individual, monthly: Explore $50 for 500
 * credits, Create $100 for 1,000, Master $250 for 2,500; and Business, one shared workspace, per seat a month with credits
 * pooled across seats: Business 100 is $100 a seat for 1,000 credits a seat, Business 250 is $250 for 2,500, Business 500 is
 * $500 for 5,000. A credit is $0.10 throughout (CLAUDE.md § Pricing). Enterprise is "Get in touch" with no price, and is not a
 * plan a workspace can be on (ENTERPRISE below).
 *
 * Invite and the three plans sold before (Studio, Agency, Production) stay as legacy rows: a workspace on one still resolves it
 * and its grants, billing and limits read it as before, and none is offered.
 */
export const DEFAULT_PLANS: PlanDef[] = [
  /* Invite includes no credits: its 250 are the one-time welcome grant. The free default of a new workspace; never offered. */
  { id: "invite", label: "Invite", priceUsd: 0, includedCredits: 0, maxProductions: 1, maxMembers: 3, group: "legacy", offered: false, perSeat: false, badge: null, blurb: null },
  { id: "studio", label: "Studio", priceUsd: 49, includedCredits: 400, maxProductions: null, maxMembers: null, group: "legacy", offered: false, perSeat: false, badge: null, blurb: null },
  { id: "agency", label: "Agency", priceUsd: 199, includedCredits: 1600, maxProductions: null, maxMembers: null, group: "legacy", offered: false, perSeat: false, badge: null, blurb: null },
  { id: "production", label: "Production", priceUsd: 999, includedCredits: 9000, maxProductions: null, maxMembers: null, group: "legacy", offered: false, perSeat: false, badge: null, blurb: null },
  { id: "explore", label: "Explore", priceUsd: 50, includedCredits: 500, maxProductions: null, maxMembers: null, group: "individual", offered: true, perSeat: false, badge: null, blurb: "For trying Particl: first films and campaigns." },
  { id: "create", label: "Create", priceUsd: 100, includedCredits: 1000, maxProductions: null, maxMembers: null, group: "individual", offered: true, perSeat: false, badge: null, blurb: "For making every week." },
  { id: "master", label: "Master", priceUsd: 250, includedCredits: 2500, maxProductions: null, maxMembers: null, group: "individual", offered: true, perSeat: false, badge: null, blurb: "For full productions." },
  { id: "business100", label: "Business 100", priceUsd: 100, includedCredits: 1000, maxProductions: null, maxMembers: null, group: "business", offered: true, perSeat: true, badge: null, blurb: null },
  { id: "business250", label: "Business 250", priceUsd: 250, includedCredits: 2500, maxProductions: null, maxMembers: null, group: "business", offered: true, perSeat: true, badge: null, blurb: null },
  { id: "business500", label: "Business 500", priceUsd: 500, includedCredits: 5000, maxProductions: null, maxMembers: null, group: "business", offered: true, perSeat: true, badge: null, blurb: null },
];

/** What the house workspace (ws_legacy) shows where a plan or a credit balance would be: it pays at cost, in dollars, and holds none. */
export const HOUSE_PLAN = { label: "House · pays at cost", line: "This workspace pays at cost: every price is the engines' own, in dollars. It holds no credits and no plan." } as const;

/** Enterprise: "Get in touch". No price, no credits and no plan id: a workspace cannot be on it, and nothing here sells it. */
export const ENTERPRISE = { id: "enterprise", label: "Enterprise", line: "Get in touch", blurb: "for large studios and agencies" } as const;

/** What the Business plans' card says around its levels and its seats stepper (display only: seats are counted by checkout, later). */
export const BUSINESS = { label: "Business", note: "One shared workspace · credits pooled across seats", seats: { min: 1, max: 99, initial: 5 } } as const;

/** The plans the public list offers, in order. */
export const offeredPlans = (plans: readonly PlanDef[]): PlanDef[] => plans.filter((p) => p.offered);
/** The offered plans of one group. */
export const plansIn = (plans: readonly PlanDef[], group: PlanGroup): PlanDef[] => offeredPlans(plans).filter((p) => p.group === group);
/** The least a business workspace pays a seat a month: the card's "from $100 per seat". Null with no business plan. */
export function businessFromUsd(plans: readonly PlanDef[]): number | null {
  const prices = plansIn(plans, "business").map((p) => p.priceUsd).filter((n) => n > 0);
  return prices.length ? Math.min(...prices) : null;
}
/** The credits a workspace's cycle includes on a plan: a seat's credits times its seats on a business plan (seats are pooled), else the plan's. */
export const cycleCredits = (plan: Pick<PlanDef, "includedCredits" | "perSeat">, seats = 1): number =>
  plan.perSeat ? plan.includedCredits * Math.max(1, Math.floor(seats)) : plan.includedCredits;

/**
 * Whether the pricing pages offer a yearly period. Not yet: the owner's final plans are monthly. The yearly discount
 * (lib/billingConfig.ts ANNUAL_DISCOUNT_PERCENT) and the annual cadence in checkout's own config are kept for when it returns.
 */
export const YEARLY_SHOWN = false;

/** The plans a person can carry through sign-up as their choice: every plan but Invite (the free default), and the one a new link starts on. */
export const CHOSEN_PLAN_IDS: readonly PlanId[] = PLAN_IDS.filter((id) => id !== "invite");
export const DEFAULT_CHOSEN_PLAN: PlanId = DEFAULT_PLANS.find((p) => p.offered)!.id;

/** A plan carried in an address or a sign-up (a choice, nothing more): any chosen plan id, else the first offered one. */
export const chosenPlanFrom = (v: unknown): PlanId => ((CHOSEN_PLAN_IDS as readonly string[]).includes(String(v)) ? (String(v) as PlanId) : DEFAULT_CHOSEN_PLAN);
/** A cadence carried the same way: "annual" only while yearly is shown (YEARLY_SHOWN), else monthly, so no annual figure appears. */
export const cadenceFrom = (v: unknown): "monthly" | "annual" => (YEARLY_SHOWN && v === "annual" ? "annual" : "monthly");

export const isPlanId = (v: unknown): v is PlanId => (PLAN_IDS as readonly string[]).includes(String(v));

/** A stored plan id, or null for a workspace on no plan at all. */
export function asPlanId(v: unknown): PlanId | null {
  return isPlanId(v) ? v : null;
}

const num = (v: unknown, fallback: number, min: number, max: number): number => {
  const n = Number(v);
  return Number.isFinite(n) && n >= min && n <= max ? Math.round(n * 100) / 100 : fallback;
};

const countOrNull = (v: unknown, fallback: number | null): number | null => {
  if (v === null) return null;
  const n = Math.floor(Number(v));
  return Number.isFinite(n) && n >= 1 && n <= 100_000 ? n : fallback;
};

/**
 * A plans table from the platform record, cleaned.
 *
 * Unknown ids are dropped and missing ones fall back to the shipped row, so
 * the four §7A plans always exist whatever is stored: a workspace pointing at
 * a plan the console deleted would otherwise resolve to nothing, and "no
 * plan" and "a plan that went missing" are not the same state.
 */
export function cleanPlans(v: unknown): PlanDef[] {
  const stored = new Map<string, Record<string, unknown>>();
  if (Array.isArray(v)) {
    for (const row of v) {
      if (row && typeof row === "object" && isPlanId((row as Record<string, unknown>).id)) {
        stored.set(String((row as Record<string, unknown>).id), row as Record<string, unknown>);
      }
    }
  }
  return DEFAULT_PLANS.map((d) => {
    const s = stored.get(d.id);
    if (!s) return { ...d };
    return {
      ...d,
      id: d.id,
      label: String(s.label ?? d.label).slice(0, 40) || d.label,
      priceUsd: num(s.priceUsd, d.priceUsd, 0, 100_000),
      /* Rounded to a whole credit: a plan grants credits, and a credit is
         the unit. A fractional inclusion would round somewhere else later. */
      includedCredits: Math.round(num(s.includedCredits, d.includedCredits, 0, 10_000_000)),
      maxProductions: s.maxProductions === undefined ? d.maxProductions : countOrNull(s.maxProductions, d.maxProductions),
      maxMembers: s.maxMembers === undefined ? d.maxMembers : countOrNull(s.maxMembers, d.maxMembers),
    };
  });
}

export function planById(plans: PlanDef[], id: string | null | undefined): PlanDef | null {
  if (!id) return null;
  return plans.find((p) => p.id === id) ?? null;
}
