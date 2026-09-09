import { test, expect } from "@playwright/test";
import { DEMO_PRODUCTION, DEMO_TAKES, demoMediaUrl, demoTotals, demoShots } from "../../lib/demoProduction";
import { estimateCostUsd } from "../../lib/vendorPricing";
import { CATEGORIES } from "../../lib/studio";

/** The demo production (brief 1.7): three shots, a few takes each, one Approved, real credit numbers, a cast of two, Setup filled, rights-clear pictures. */
test("the demo production has the shape the brief asks for, with the catalogue's own prices", () => {
  expect(DEMO_PRODUCTION.shots.length).toBe(3);
  expect(DEMO_PRODUCTION.cast.length).toBe(2);
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
