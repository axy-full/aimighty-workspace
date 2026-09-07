import { test, expect } from "@playwright/test";
import { capVerdict } from "../../lib/caps";

/** The three rules at a production's cap, and the warning on the way there. */
test("no cap, no verdict", () => {
  expect(capVerdict({ cap: null, spent: 900, needs: 40, rule: "stop", unlocked: false, warnPct: 80, unit: "cr" })).toEqual({ allow: true, pct: null, warned: false });
});

test("the warning threshold speaks once the take would cross it", () => {
  const v = capVerdict({ cap: 1000, spent: 770, needs: 40, rule: "producer", unlocked: false, warnPct: 80, unit: "cr" });
  expect(v.allow).toBe(true);
  expect(v.warned).toBe(true);
  expect(v.pct).toBe(81);
  expect(v.notice).toContain("81%");
  expect(capVerdict({ cap: 1000, spent: 700, needs: 40, rule: "producer", unlocked: false, warnPct: 80, unit: "cr" }).warned).toBe(false);
});

test("stop refuses over the cap; producer refuses until unlocked; warn lets it through", () => {
  const base = { cap: 1000, spent: 980, needs: 40, unlocked: false, warnPct: 80, unit: "cr" as const };
  expect(capVerdict({ ...base, rule: "stop" }).allow).toBe(false);
  expect(capVerdict({ ...base, rule: "stop" }).error).toContain("raise the cap");
  expect(capVerdict({ ...base, rule: "producer" }).allow).toBe(false);
  expect(capVerdict({ ...base, rule: "producer", unlocked: true }).allow).toBe(true);
  expect(capVerdict({ ...base, rule: "producer", unlocked: true }).notice).toContain("unlocked");
  const warn = capVerdict({ ...base, rule: "warn" });
  expect(warn.allow).toBe(true);
  expect(warn.notice).toContain("by 20 cr");
});

test("exactly at the cap is not over it, and dollars read as dollars", () => {
  expect(capVerdict({ cap: 100, spent: 60, needs: 40, rule: "stop", unlocked: false, warnPct: 80, unit: "$" }).allow).toBe(true);
  expect(capVerdict({ cap: 100, spent: 60, needs: 40.01, rule: "stop", unlocked: false, warnPct: 80, unit: "$" }).error).toContain("$100.00");
});
