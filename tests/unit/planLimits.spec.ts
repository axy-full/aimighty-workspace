import { test, expect } from "@playwright/test";
import { ceilingFor, wouldExceed, ceilingMessage } from "../../lib/planLimits";
import { DEFAULT_PLANS, planById } from "../../lib/plans";

const invite = planById(DEFAULT_PLANS, "invite")!;
const studio = planById(DEFAULT_PLANS, "studio")!;

/** §7A's two counted ceilings, and the one plan that has any. */
test("only Invite counts anything", () => {
  expect(ceilingFor(invite, "productions")).toBe(1);
  expect(ceilingFor(invite, "members")).toBe(3);
  for (const id of ["studio", "agency", "production"]) {
    const p = planById(DEFAULT_PLANS, id)!;
    expect(ceilingFor(p, "productions"), id).toBeNull();
    expect(ceilingFor(p, "members"), `${id}: no seat fees on any paid plan`).toBeNull();
  }
});

test("no plan is no ceiling, which is every workspace today", () => {
  /* The dangerous default. Reading "no plan" as Invite would apply a
     one-production limit to workspaces holding twelve, and the first thing
     they would notice is being unable to work. It is also what a workspace
     created by older code lands on mid-deploy. */
  expect(ceilingFor(null, "productions")).toBeNull();
  expect(ceilingFor(undefined, "members")).toBeNull();
  expect(wouldExceed(9999, null)).toBe(false);
});

test("the ceiling is on ADDING, not on having", () => {
  // One production and Invite allows one: no more.
  expect(wouldExceed(1, 1)).toBe(true);
  // None yet: the first is fine.
  expect(wouldExceed(0, 1)).toBe(false);
  expect(wouldExceed(2, 3)).toBe(false);
  expect(wouldExceed(3, 3)).toBe(true);
});

test("a workspace already over its ceiling is stopped from adding, not emptied", () => {
  /* Somebody moved from Agency to Invite still holds four productions. This
     refuses a fifth and touches none of the four: deleting work to fit a plan
     change is not a thing that should ever happen quietly. */
  expect(wouldExceed(4, 1)).toBe(true);
  expect(wouldExceed(12, 3)).toBe(true);
});

test("the message names the plan and what changes it", () => {
  /* The person hitting the members ceiling is usually not the person who
     chose the plan — an invited colleague finds out as they accept — so it
     has to say which plan, and what to do, not just "no". */
  const m = ceilingMessage(invite, "members", 3);
  expect(m).toContain("Invite");
  expect(m).toContain("3 members");
  expect(m).toContain("larger plan");
  expect(ceilingMessage(invite, "productions", 1)).toContain("1 production");
  expect(ceilingMessage(invite, "productions", 1)).not.toContain("1 productions");
  expect(ceilingMessage(studio, "members", 1)).toContain("allows 1 member.");
});

test("a nonsensical ceiling is no ceiling rather than a lockout", () => {
  /* A plan edited to zero members would otherwise refuse everybody,
     including the owner, with no way back in through the product. */
  expect(ceilingFor({ ...invite, maxMembers: 0 }, "members")).toBeNull();
  expect(ceilingFor({ ...invite, maxProductions: -1 }, "productions")).toBeNull();
});
