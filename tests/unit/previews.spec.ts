import { test, expect } from "@playwright/test";
import { previewItems, supportedDuration, PREVIEW_SCENE } from "../../lib/previews";
import { previewPlan } from "../../lib/previewCost";
import { estimateCostUsd } from "../../lib/vendorPricing";
import { getModel } from "../../lib/models";

/** The bank's neutral previews (brief 1.4): one clip per move and technique, one scene, priced exactly before anything runs. */
test("the plan covers every move and technique once, from the one scene, at the catalogue's price", () => {
  const items = previewItems();
  expect(items.length).toBe(36);
  expect(new Set(items.map((i) => i.key)).size).toBe(36);
  expect(items.every((i) => i.prompt === PREVIEW_SCENE)).toBe(true);
  expect(items.find((i) => i.key === "move:push")?.shotSpec).toEqual({ move: "push" });
  expect(items.find((i) => i.key === "technique:dollyzoom")?.shotSpec).toEqual({ technique: "dollyzoom" });
  const plan = previewPlan("dreamina-seedance-2-0-260128", "480p", 3);
  // The plan prices the length the engine will really render, never a length it would silently round up from.
  expect(getModel("dreamina-seedance-2-0-260128").durations).toContain(plan.duration);
  expect(plan.duration).toBe(supportedDuration("dreamina-seedance-2-0-260128", 3));
  const one = estimateCostUsd("dreamina-seedance-2-0-260128", "480p", "16:9", plan.duration, 0, false, { audio: false })!.net;
  expect(plan.perClipUsd).toBe(one);
  expect(plan.totalUsd).toBe(Math.round(one * 36 * 100) / 100);
  expect(plan.totalUsd).toBeGreaterThan(5);
  expect(plan.totalUsd).toBeLessThan(15);
});
