import { test, expect } from "@playwright/test";
import { MAX_SCREEN_SCALE, screenScale } from "../../lib/v12/board/screen-scale";
import { POSTER_TIERS, posterTier } from "../../lib/posterTier";
import { gridColumns } from "../../lib/v12/board/grid";

/* Large screens (owner, 15 Oct 2026, 22:30): the board canvas scales up above 1440 px wide, as a zoom-to-fit would; at or below 1440 it is exactly as it was. */
test("the canvas scale is 1 at or below 1440 wide, grows with the window above it, fits both ways, and stops at 2", () => {
  for (const [w, h] of [[360, 640], [390, 844], [844, 390], [1024, 768], [1280, 800], [1440, 900], [1440, 1440], [1440, 600]]) expect(screenScale(w, h), `${w}x${h}`).toBe(1);
  expect(screenScale(1728, 1117)).toBe(1.2);
  expect(screenScale(1920, 1080)).toBe(1.2);
  expect(screenScale(2560, 1440)).toBe(1.6);
  expect(screenScale(2880, 1800)).toBe(2);
  expect(screenScale(7680, 4320)).toBe(MAX_SCREEN_SCALE);
  // A short, wide window is limited by its height; a tall, narrow one by its width.
  expect(screenScale(2560, 900)).toBe(1);
  expect(screenScale(1500, 2000)).toBeCloseTo(1.04, 2);
  for (const bad of [NaN, Infinity, -1, 0]) expect(screenScale(bad, 900)).toBe(1);
  expect(screenScale(2000, 0)).toBe(1);
});

test("the groups across are counted in the canvas's own units: the canvas width divided by the scale, so what is counted always fits what is drawn", () => {
  const canvas = (width: number) => width - 88 - 340; // the rail and the Atomik column are their own size
  expect(gridColumns(canvas(1440))).toBe(3);
  for (const [w, h] of [[1280, 800], [1440, 900], [1728, 1117], [1920, 1080], [2560, 1440]]) {
    const scale = screenScale(w, h);
    const across = gridColumns(canvas(w) / scale);
    expect(across, `${w}x${h}`).toBeGreaterThanOrEqual(2);
    expect(across, `${w}x${h}`).toBeLessThanOrEqual(4);
    // The drawn width of that many columns (132 of sides, 284 a column, 24 of gap) is never more than the canvas.
    expect((132 - 24 + across * 284) * scale, `${w}x${h}`).toBeLessThanOrEqual(canvas(w) + 1);
  }
});

test("a poster is captured as wide as the picture is drawn, in tiers, and never wider than the largest", () => {
  expect(POSTER_TIERS).toEqual([480, 960, 1440, 1920]);
  expect(posterTier(0)).toBe(480);
  expect(posterTier(NaN)).toBe(480);
  expect(posterTier(260, 1)).toBe(480);
  expect(posterTier(312, 2)).toBe(960);
  expect(posterTier(416, 1)).toBe(480);
  expect(posterTier(416, 2)).toBe(960);
  expect(posterTier(500, 2)).toBe(1440);
  expect(posterTier(1200, 2)).toBe(1920);
  expect(posterTier(5000, 3)).toBe(1920);
  // A pixel ratio above 2 is read as 2; below 1 as 1.
  expect(posterTier(400, 3)).toBe(960);
  expect(posterTier(400, 0.5)).toBe(480);
});
