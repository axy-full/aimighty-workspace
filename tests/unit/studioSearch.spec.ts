import { test, expect } from "@playwright/test";
import { CATEGORIES, matchesStudio, positiveText, orderByUse } from "../../lib/studio";

const opt = (key: string, value: string) => CATEGORIES.find((c) => c.key === key)!.options.find((o) => o.value === value)!;

/** The bank's search (brief 1.4): "dolly" finds Dolly zoom and Push in, not the moves whose module says "no dolly". */
test("search matches a move's own words, never what it is not", () => {
  expect(matchesStudio(opt("move", "push"), "dolly")).toBe(true);
  expect(matchesStudio(opt("technique", "dollyzoom"), "dolly")).toBe(true);
  expect(matchesStudio(opt("move", "pan"), "dolly")).toBe(false);
  expect(matchesStudio(opt("move", "tilt"), "dolly")).toBe(false);
  expect(matchesStudio(opt("move", "push"), "")).toBe(true);
  expect(positiveText("The camera travels on a dolly. No zoom, no pan; never a tilt.")).not.toMatch(/zoom|pan|tilt/);
  expect(positiveText("The camera travels on a dolly. No zoom, no pan; never a tilt.")).toMatch(/dolly/);
});

test("the order is used-in-production, then used-in-workspace, then alphabetical", () => {
  const items = [{ label: "Pan" }, { label: "Push in" }, { label: "Handheld" }, { label: "Arc" }];
  const prod = new Map([["Push in", 2]]); const ws = new Map([["Handheld", 5], ["Push in", 1]]);
  expect(orderByUse(items, (i) => i.label, prod, ws).map((i) => i.label)).toEqual(["Push in", "Handheld", "Arc", "Pan"]);
});
