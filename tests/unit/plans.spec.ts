import { test, expect } from "@playwright/test";
import { DEFAULT_PLANS, cleanPlans, planById, asPlanId, PLAN_IDS } from "../../lib/plans";
import { mergeLayer, DEFAULT_LAYER, LAYER_KEYS } from "../../lib/platformLayer";

/** SOW §7A's four plans, credits only (panels struck 10 September 2026). */
test("the four plans are §7A's four, at §7A's prices", () => {
  expect(DEFAULT_PLANS.map((p) => p.id)).toEqual(["invite", "studio", "agency", "production"]);
  expect(DEFAULT_PLANS.map((p) => p.priceUsd)).toEqual([0, 49, 199, 999]);
  expect(DEFAULT_PLANS.map((p) => p.includedCredits)).toEqual([0, 400, 1600, 9000]);
});

test("Invite includes no credits, because its 50 are the welcome grant", () => {
  /* §7A guardrail 1: "Free grant is one-time, never recurring." The 50 are
     written once at sign-up and already marked `welcome` in the ledger.
     Putting them here would grant them again every cycle and turn a signup
     gift into a monthly stipend for every free workspace on the platform. */
  expect(planById(DEFAULT_PLANS, "invite")!.includedCredits).toBe(0);
});

test("only Invite is counted; a paid plan charges nothing for headcount", () => {
  // §7A: "No seat fees on any paid tier. Differentiate on credits, priority
  // and features, never headcount."
  const invite = planById(DEFAULT_PLANS, "invite")!;
  expect(invite.maxProductions).toBe(1);
  expect(invite.maxMembers).toBe(3);
  for (const id of ["studio", "agency", "production"]) {
    const p = planById(DEFAULT_PLANS, id)!;
    expect(p.maxMembers, `${id} charges no seat fee`).toBeNull();
    expect(p.maxProductions, `${id} is uncounted`).toBeNull();
  }
});

test("a bigger plan never includes fewer credits than a smaller one", () => {
  for (let i = 1; i < DEFAULT_PLANS.length; i++) {
    expect(DEFAULT_PLANS[i].priceUsd).toBeGreaterThan(DEFAULT_PLANS[i - 1].priceUsd);
    expect(DEFAULT_PLANS[i].includedCredits).toBeGreaterThanOrEqual(DEFAULT_PLANS[i - 1].includedCredits);
  }
});

test("a stored id is one of the four, or null", () => {
  for (const id of PLAN_IDS) expect(asPlanId(id)).toBe(id);
  // Null is a real answer — "on no plan" — and is not the same as Invite.
  for (const bad of [null, undefined, "", "Studio", "enterprise", 7, {}]) {
    expect(asPlanId(bad), String(bad)).toBeNull();
  }
});

test("the four plans survive whatever is stored", () => {
  /* A workspace pointing at a plan an edit removed would otherwise resolve
     to nothing, and "on no plan" and "on a plan that went missing" are
     different states. Only the first is real. */
  expect(cleanPlans(null).map((p) => p.id)).toEqual(["invite", "studio", "agency", "production"]);
  expect(cleanPlans([]).map((p) => p.id)).toEqual(["invite", "studio", "agency", "production"]);
  expect(cleanPlans([{ id: "enterprise", priceUsd: 5 }]).map((p) => p.id))
    .toEqual(["invite", "studio", "agency", "production"]);
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
  // An empty record still yields the four, so the console can open on them.
  expect(mergeLayer({}).plans).toEqual(DEFAULT_PLANS);
  expect(mergeLayer({ plans: [{ id: "studio", priceUsd: 59 }] }).plans.find((p) => p.id === "studio")!.priceUsd).toBe(59);
});
