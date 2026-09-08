import { test, expect } from "@playwright/test";
import { menuPlacement, MENU_EDGE, MENU_GAP, MENU_MIN_HEIGHT } from "../../lib/menuPlacement";

const view = { width: 900, height: 950 };
const chip = (top: number, left: number) => ({ top, bottom: top + 30, left, right: left + 90 });

/** Where a chip's menu goes (the hidden-picker fix): above when there is room, below when there is not, never past an edge. */
test("a menu opens above its chip when there is room, and below when there is not", () => {
  const roomy = menuPlacement(chip(600, 300), view, 220);
  expect(roomy.above).toBe(true);
  expect(roomy.bottom).toBe(view.height - 600 + MENU_GAP);
  expect(roomy.top).toBeUndefined();
  const tight = menuPlacement(chip(40, 300), view, 220);
  expect(tight.above).toBe(false);
  expect(tight.top).toBe(70 + MENU_GAP);
  expect(tight.maxHeight).toBeGreaterThan(MENU_MIN_HEIGHT);
});

test("a menu never runs past an edge, and always has room to show something", () => {
  expect(menuPlacement(chip(600, 860), view, 300).left).toBe(view.width - 300 - MENU_EDGE);
  expect(menuPlacement(chip(600, -40), view, 220).left).toBe(MENU_EDGE);
  expect(menuPlacement(chip(600, 300), view, 220).left).toBe(300);
  // A chip squeezed against both edges still gets a usable menu rather than a sliver.
  const squeezed = menuPlacement(chip(120, 300), { width: 900, height: 200 }, 220);
  expect(squeezed.maxHeight).toBeGreaterThanOrEqual(MENU_MIN_HEIGHT - MENU_EDGE);
});
