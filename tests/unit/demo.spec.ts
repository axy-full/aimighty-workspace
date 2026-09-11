import { test, expect } from "@playwright/test";
import { DEMO_PRODUCTION, DEMO_TAKES, demoMediaUrl, demoTotals, demoShots } from "../../lib/demoProduction";
import { estimateCostUsd } from "../../lib/vendorPricing";
import { CATEGORIES } from "../../lib/studio";

/** The demo production (brief 1.7): three shots, a few takes each, one Approved, real credit numbers, the starter's cast of four, Setup filled, rights-clear pictures. */
test("the demo production has the shape the brief asks for, with the catalogue's own prices", () => {
  expect(DEMO_PRODUCTION.shots.length).toBe(3);
  expect(DEMO_PRODUCTION.cast.length).toBe(4);
  expect(DEMO_TAKES.length).toBeGreaterThanOrEqual(6);
  expect(DEMO_TAKES.filter((t) => t.approved).length).toBe(1);
  for (const t of DEMO_TAKES) {
    expect(t.costUsd).toBe(estimateCostUsd(t.model, t.resolution, "16:9", t.duration, 0, false, { audio: true })!.net);
    expect(t.costUsd).toBeGreaterThan(0);
    expect(DEMO_PRODUCTION.shots.some((s) => s.code === t.shotCode)).toBe(true);
  }
  const versions = DEMO_TAKES.map((t) => `${t.shotCode}-v${t.version}`);
  expect(new Set(versions).size).toBe(versions.length);
  // Every shot's Setup is filled from the platform's default underneath its own picks.
  for (const s of demoShots()) expect(Object.keys(s.setupFull).length).toBeGreaterThanOrEqual(CATEGORIES.length - 2);
  expect(demoTotals().approved).toBe(1);
  expect(demoMediaUrl("move:push", new Set(["move:push"]))).toBe("/api/platform/previews/move%3Apush");
  expect(demoMediaUrl("move:push", new Set())).toBe("/fixtures/clip.mp4");
});

test("the starter's first shot is open, so a stranger's first render is not refused", () => {
  /* Rule 6: a stranger reaches a first render "without reading a paragraph".
     A shot with an approved take is LOCKED — the next render against it has
     to say why (lib/approval.ts) — so an approved take on the shot the
     product opens people on means their first Generate comes back with a
     question instead of a render. It did: the onboarding test, which is
     rule 6's own acceptance test, failed on exactly this.

     The demonstration of an approved take is worth keeping, so it lives on
     the LAST shot instead. What must never come back is a lock on the
     first. */
  const first = DEMO_PRODUCTION.shots[0].code;
  const lockedShots = new Set(DEMO_TAKES.filter((t) => t.approved).map((t) => t.shotCode));
  expect(lockedShots.has(first), `${first} is the first shot and must not open locked`).toBe(false);
  // And the demonstration is still there, just out of the way.
  expect(lockedShots.size).toBe(1);
});
