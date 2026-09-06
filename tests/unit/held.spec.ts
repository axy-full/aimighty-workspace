import { test, expect } from "@playwright/test";
import { planRelease } from "../../lib/held";

/** Held takes are released oldest first, and the first that does not fit stops the line. */
test("release is in order and stops at the first take that does not fit", () => {
  const held = [{ id: "a", needs: 40 }, { id: "b", needs: 3 }, { id: "c", needs: 40 }, { id: "d", needs: 1 }];
  expect(planRelease(held, 45)).toEqual({ release: ["a", "b"], short: ["c", "d"] });
  expect(planRelease(held, 0)).toEqual({ release: [], short: ["a", "b", "c", "d"] });
  expect(planRelease(held, 84)).toEqual({ release: ["a", "b", "c", "d"], short: [] });
});

test("a workspace that no longer pays in credits releases everything", () => {
  expect(planRelease([{ id: "a", needs: 40 }], null)).toEqual({ release: ["a"], short: [] });
});

test("an exact balance releases the take", () => {
  expect(planRelease([{ id: "a", needs: 40 }], 40)).toEqual({ release: ["a"], short: [] });
  expect(planRelease([{ id: "a", needs: 41 }], 40)).toEqual({ release: [], short: ["a"] });
});
