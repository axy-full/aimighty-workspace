import { test, expect } from "@playwright/test";
import { STARTER_PRODUCTION, DEFAULT_SETUP } from "../../lib/platformLayer";
import { CATEGORIES } from "../../lib/studio";

/** The starter production is three named shots, one cast member, and a Setup the Studio recognises. */
test("the platform's default Setup is made of real Studio options", () => {
  for (const [key, value] of Object.entries(DEFAULT_SETUP)) {
    const cat = CATEGORIES.find((c) => c.key === key);
    expect(cat, `category ${key}`).toBeTruthy();
    expect(cat!.options.some((o) => o.value === value), `${key}=${value}`).toBe(true);
  }
});

test("the starter production has three distinct shots, each with a Setup, and one cast member", () => {
  const codes = STARTER_PRODUCTION.shots.map((s) => s.code);
  expect(codes).toEqual(["SH010", "SH020", "SH030"]);
  expect(new Set(codes).size).toBe(3);
  for (const s of STARTER_PRODUCTION.shots) {
    expect(Object.keys(s.setup).length).toBeGreaterThanOrEqual(8);
    expect(s.title.length).toBeGreaterThan(0);
    expect(s.planned).toBeGreaterThan(0);
  }
  expect(STARTER_PRODUCTION.cast.length).toBe(1);
  expect(STARTER_PRODUCTION.shots.some((s) => s.cast.includes(STARTER_PRODUCTION.cast[0].name))).toBe(true);
});
