import { test, expect } from "@playwright/test";
import { getModel } from "../../lib/models";
import { estimateCostUsd, perSecondRate } from "../../lib/vendorPricing";
import { getTask, sourceProblem } from "../../lib/tasks";
import { falEndpointFor } from "../../lib/falVideo";
import { billCredits } from "../../lib/creditTerms";

const ID = "fal-ai/luma-dream-machine/ray-2-flash/reframe";

/** Reframe (brief 1.2): a finished clip re-cut to another aspect, priced per second at fal's rate, filed as a take. */
test("reframe is a locked task on Luma Ray 2, priced at $0.06 a second, and takes any finished clip", () => {
  const model = getModel(ID);
  const task = getTask("reframe");
  expect(task.locked).toBe(true);
  expect(task.forceDuration).toBe("source");
  expect(task.forceRatio).toBeNull(); // the target ratio is the one control that matters
  expect(model.supportsTasks).toEqual(["reframe"]);
  expect(model.ratios).toEqual(["9:16", "1:1", "16:9", "4:3", "3:4", "21:9", "9:21"]);
  expect(falEndpointFor(model, "reframe", false)).toBe(ID);
  expect(perSecondRate(ID, "adaptive", { task: "reframe" })).toBe(0.06);
  expect(estimateCostUsd(ID, "adaptive", "9:16", 5, 0, true, { task: "reframe" })?.net).toBe(0.3);
  expect(billCredits(0.3, ID)).toBe(5); // 0.30 × 1.4 / 0.10 = 4.2 → 5 whole credits
  // Unlike an edit, a 1080p source is fine; only the five-minute ceiling applies.
  expect(sourceProblem(task, { resolution: "1080p", duration: 5 })).toBeNull();
  expect(sourceProblem(task, { resolution: "720p", duration: 301 })).toMatch(/five minutes/);
});
