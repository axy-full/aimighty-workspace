import { test, expect } from "@playwright/test";
import { railGeometry, railState, railTip } from "../../components/v12/board/rail-model";
import { RAIL_ICONS, railIcon } from "../../components/v12/board/rail-icons";

/* The v25 rail's rules (components/v12/board/rail-model.ts; design/particl-prototype-25 README "V24 · A · Look" 2, "V25" 7). */

test("all ten Film steps fit at 1280 x 800 without scrolling: the canvas is 700 px tall, so the circles shrink to 26 px with the gap tightened", () => {
  const g = railGeometry({ height: 700, count: 10 });
  expect(g).toEqual({ circle: 26, icon: 12, gap: 5, compact: true });
  /* What the ten steps need: the circle, its 4 + 14 px label row and 2 gaps each, the panel's padding and the add button. */
  const need = 10 * (g.circle + 4 + 14 + 2 * g.gap) + (g.circle + 4 + 2 + g.gap) + 16;
  expect(need).toBeLessThanOrEqual(700 - 32);
});

test("tall canvases keep 30 px circles, and the gap stops at 16", () => {
  /* 1440 x 900 leaves a canvas 800 px tall: ten steps keep 30 px circles with a 7 px gap. */
  expect(railGeometry({ height: 800, count: 10 })).toEqual({ circle: 30, icon: 14, gap: 7, compact: false });
  expect(railGeometry({ height: 1200, count: 5 })).toMatchObject({ circle: 30, gap: 16, compact: false });
  expect(railGeometry({ height: 1000, count: 10 }).gap).toBe(16);
});

test("spacing tightens before the circles shrink, and never goes under 2 px, however many steps", () => {
  const gaps = [4, 6, 8, 10].map((count) => railGeometry({ height: 700, count }).gap);
  for (let i = 1; i < gaps.length; i++) expect(gaps[i]).toBeLessThanOrEqual(gaps[i - 1]);
  expect(railGeometry({ height: 700, count: 30 })).toMatchObject({ circle: 26, gap: 2 });
  expect(railGeometry({ height: 100, count: 3 }).gap).toBe(2);
});

test("the screen can nudge the gap tighter (a status that wraps), within 2 to 16", () => {
  expect(railGeometry({ height: 800, count: 10, shrink: 2 }).gap).toBe(5);
  expect(railGeometry({ height: 800, count: 10, shrink: 50 }).gap).toBe(2);
});

test("the current step is ringed whether or not it is done; done shows a tick; the rest are idle", () => {
  expect(railState({ id: "a", current: "a" })).toBe("current");
  expect(railState({ id: "a", current: "a", done: true })).toBe("current");
  expect(railState({ id: "b", current: "a", done: true })).toBe("done");
  expect(railState({ id: "b", current: "a" })).toBe("idle");
  expect(railState({ id: "b", current: null })).toBe("idle");
});

test("a tooltip says the status, and that a step is optional", () => {
  expect(railTip({ status: "Not started" })).toBe("Not started");
  expect(railTip({ status: "Done", optional: true })).toBe("Optional · Done");
});

test("every rail icon is a 16 x 16 path, and an unknown step gets the Elements one", () => {
  expect(Object.keys(RAIL_ICONS)).toHaveLength(22);
  for (const [id, d] of Object.entries(RAIL_ICONS)) expect(d, id).toMatch(/^M[\d .,\-MLHVAZCSQTmlhvazcsqt]+$/);
  expect(railIcon("nonsense")).toBe(RAIL_ICONS.elements);
  expect(railIcon("shots")).toBe(RAIL_ICONS.shots);
});
