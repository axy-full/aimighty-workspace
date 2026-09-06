import { test, expect } from "@playwright/test";
import { billCreditsWith, marginFor, DEFAULT_MARGINS } from "../../lib/creditTerms";

/** The rounding rule every price on a button and every meter row shares. */
test("nothing costs nothing; anything that costs money costs at least one credit", () => {
  expect(billCreditsWith(0, 1.4, 0.1)).toBe(0);
  expect(billCreditsWith(-1, 1.4, 0.1)).toBe(0);
  expect(billCreditsWith(0.0003, 1, 0.1)).toBe(1);
});

test("a job rounds up to the next whole credit at its engine's margin", () => {
  // A 5-second Seedance 2.5 1080p shot, $2.864 at the vendor.
  expect(billCreditsWith(2.864, marginFor("dreamina-seedance-2-5-260628", DEFAULT_MARGINS), 0.1)).toBe(40);
  // A 5-second Kling 3.0 standard shot, $0.42.
  expect(billCreditsWith(0.42, marginFor("fal-ai/kling-video/v3/standard", DEFAULT_MARGINS), 0.1)).toBe(6);
  // One Nano Banana Pro still, $0.134.
  expect(billCreditsWith(0.134, marginFor("gemini-3-pro-image", DEFAULT_MARGINS), 0.1)).toBe(2);
  // A whole-number boundary rounds exactly, not up again.
  expect(billCreditsWith(1, 1, 0.1)).toBe(10);
});

test("batches multiply before they round", () => {
  const unit = 0.134;
  const four = billCreditsWith(unit * 4, marginFor("gemini-3-pro-image", DEFAULT_MARGINS), 0.1);
  expect(four).toBe(8);
  expect(four).toBeLessThanOrEqual(4 * billCreditsWith(unit, marginFor("gemini-3-pro-image", DEFAULT_MARGINS), 0.1));
});

test("an unknown engine falls back to the table's default margin", () => {
  expect(marginFor("some-new-engine", DEFAULT_MARGINS)).toBe(DEFAULT_MARGINS["*"]);
  expect(marginFor(null, DEFAULT_MARGINS)).toBe(DEFAULT_MARGINS["*"]);
});
