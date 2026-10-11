import { test, expect } from "@playwright/test";
import { DEFAULT_PLANS, ENTERPRISE, YEARLY_SHOWN, businessFromUsd, cleanPlans, cycleCredits, offeredPlans, planById, plansIn, asPlanId, PLAN_IDS } from "../../lib/plans";
import { mergeLayer, DEFAULT_LAYER, LAYER_KEYS } from "../../lib/platformLayer";

/** The owner's final plans (CLAUDE.md § Pricing), then the legacy rows a workspace on one still resolves. */
test("the offered plans are the owner's final list, at the owner's prices; the legacy rows stay, hidden", () => {
  const offered = DEFAULT_PLANS.filter((p) => p.offered);
  expect(offered.map((p) => p.id)).toEqual(["explore", "create", "master", "business100", "business250", "business500"]);
  expect(offered.map((p) => p.priceUsd)).toEqual([50, 100, 250, 100, 250, 500]);
  expect(offered.map((p) => p.includedCredits)).toEqual([500, 1000, 2500, 1000, 2500, 5000]);
  expect(offered.map((p) => p.perSeat)).toEqual([false, false, false, true, true, true]);
  /* A credit is $0.10 throughout: every plan's credits are ten to the dollar. */
  for (const p of offered) expect(p.includedCredits, p.id).toBe(p.priceUsd * 10);
  expect(offeredPlans(DEFAULT_PLANS)).toEqual(offered);
  expect(plansIn(DEFAULT_PLANS, "business").map((p) => p.label)).toEqual(["Business 100", "Business 250", "Business 500"]);
  expect(businessFromUsd(DEFAULT_PLANS)).toBe(100);
  /* Invite, Studio, Agency and Production are never offered, and keep their figures. */
  const legacy = DEFAULT_PLANS.filter((p) => !p.offered);
  expect(legacy.map((p) => p.id)).toEqual(["invite", "studio", "agency", "production"]);
  expect(legacy.map((p) => p.priceUsd)).toEqual([0, 49, 199, 999]);
  expect(legacy.map((p) => p.includedCredits)).toEqual([0, 400, 1600, 9000]);
  expect(legacy.every((p) => p.group === "legacy")).toBe(true);
  /* Enterprise is "Get in touch": no price, and not a plan a workspace can be on. */
  expect(ENTERPRISE.line).toBe("Get in touch");
  expect(DEFAULT_PLANS.some((p) => p.id === (ENTERPRISE.id as string))).toBe(false);
  /* The pricing pages offer no yearly period. */
  expect(YEARLY_SHOWN).toBe(false);
});

test("a business plan's credits are pooled: a seat's credits times its seats; any other plan's are its own", () => {
  const business = planById(DEFAULT_PLANS, "business250")!;
  expect(cycleCredits(business, 1)).toBe(2500);
  expect(cycleCredits(business, 4)).toBe(10_000);
  expect(cycleCredits(business, 0), "no workspace has fewer than one seat").toBe(2500);
  expect(cycleCredits(planById(DEFAULT_PLANS, "create")!, 4), "an individual plan has no seats").toBe(1000);
});

test("Invite includes no credits, because its 250 are the welcome grant", () => {
  /* §7A guardrail 1: "Free grant is one-time, never recurring." The 250 are
     written once at sign-up and already marked `welcome` in the ledger.
     Putting them here would grant them again every cycle and turn a signup
     gift into a monthly stipend for every free workspace on the platform. */
  expect(planById(DEFAULT_PLANS, "invite")!.includedCredits).toBe(0);
});

test("only Invite is counted; no other plan caps people or projects, and a business plan's seats are pooled, not capped here", () => {
  const invite = planById(DEFAULT_PLANS, "invite")!;
  expect(invite.maxProductions).toBe(1);
  expect(invite.maxMembers).toBe(3);
  for (const p of DEFAULT_PLANS.filter((q) => q.id !== "invite")) {
    expect(p.maxMembers, `${p.id} caps no members`).toBeNull();
    expect(p.maxProductions, `${p.id} is uncounted`).toBeNull();
  }
});

test("within a group, a bigger plan never includes fewer credits than a smaller one", () => {
  for (const group of ["individual", "business", "legacy"] as const) {
    const rows = DEFAULT_PLANS.filter((p) => p.group === group);
    for (let i = 1; i < rows.length; i++) {
      expect(rows[i].priceUsd, `${group}: ${rows[i].id}`).toBeGreaterThan(rows[i - 1].priceUsd);
      expect(rows[i].includedCredits).toBeGreaterThanOrEqual(rows[i - 1].includedCredits);
    }
  }
});

test("a stored id is one of the plans, or null", () => {
  for (const id of PLAN_IDS) expect(asPlanId(id)).toBe(id);
  // Null is a real answer — "on no plan" — and is not the same as Invite.
  for (const bad of [null, undefined, "", "Studio", "enterprise", 7, {}]) {
    expect(asPlanId(bad), String(bad)).toBeNull();
  }
});

test("every plan survives whatever is stored", () => {
  /* A workspace pointing at a plan an edit removed would otherwise resolve
     to nothing, and "on no plan" and "on a plan that went missing" are
     different states. Only the first is real. */
  const all = DEFAULT_PLANS.map((p) => p.id);
  expect(cleanPlans(null).map((p) => p.id)).toEqual(all);
  expect(cleanPlans([]).map((p) => p.id)).toEqual(all);
  expect(cleanPlans([{ id: "enterprise", priceUsd: 5 }]).map((p) => p.id)).toEqual(all);
  /* What group a plan is in, and whether it is offered, is the shipped row's, whatever is stored. */
  expect(planById(cleanPlans([{ id: "studio", offered: true, group: "individual", perSeat: true }]), "studio")).toMatchObject({ offered: false, group: "legacy", perSeat: false });
  expect(cleanPlans("nonsense")).toEqual(DEFAULT_PLANS);
});

test("an edit changes what it names and nothing else", () => {
  const edited = cleanPlans([{ id: "studio", priceUsd: 59, includedCredits: 500 }]);
  const studio = planById(edited, "studio")!;
  expect(studio.priceUsd).toBe(59);
  expect(studio.includedCredits).toBe(500);
  expect(studio.label, "an unnamed field keeps its shipped value").toBe("Studio");
  expect(planById(edited, "agency")).toEqual(planById(DEFAULT_PLANS, "agency"));
});

test("nonsense in an edit falls back rather than through", () => {
  const bad = cleanPlans([{ id: "agency", priceUsd: Number.NaN, includedCredits: -5, maxMembers: 0 }]);
  const agency = planById(bad, "agency")!;
  expect(agency.priceUsd, "NaN keeps the shipped price").toBe(199);
  expect(agency.includedCredits, "a negative inclusion is not an inclusion").toBe(1600);
  expect(agency.maxMembers, "a zero-member plan would lock the owner out").toBeNull();
  // ...but an explicit null IS the way to say unlimited.
  expect(planById(cleanPlans([{ id: "invite", maxMembers: null }]), "invite")!.maxMembers).toBeNull();
});

test("plans are a platform-layer key like the other five", () => {
  expect(LAYER_KEYS).toContain("plans");
  expect(DEFAULT_LAYER.plans).toEqual(DEFAULT_PLANS);
  // An empty record still yields every plan, so the console can open on them.
  expect(mergeLayer({}).plans).toEqual(DEFAULT_PLANS);
  expect(mergeLayer({ plans: [{ id: "studio", priceUsd: 59 }] }).plans.find((p) => p.id === "studio")!.priceUsd).toBe(59);
});

test("the owner's plans claim only what the owner gave: credits, who it is for, and nothing invented", async () => {
  const { planLines, PLAN_AUDIENCE } = await import("../../lib/marketing/plans");
  for (const id of ["explore", "create", "master"]) {
    const plan = planById(DEFAULT_PLANS, id)!;
    const lines = planLines(plan, 250);
    expect(lines, id).toEqual([`${plan.includedCredits.toLocaleString("en-US")} credits a month`, "One person"]);
    expect(PLAN_AUDIENCE[id]).toBe("For one person.");
    expect(plan.badge, `${id} carries no badge the owner did not give`).toBeNull();
  }
  for (const id of ["business100", "business250", "business500"]) {
    const plan = planById(DEFAULT_PLANS, id)!;
    expect(planLines(plan, 250), id).toEqual([`${plan.includedCredits.toLocaleString("en-US")} credits a seat a month`, "One pool of credits across every seat"]);
  }
});
