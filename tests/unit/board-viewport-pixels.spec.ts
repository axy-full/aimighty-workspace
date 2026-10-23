import { test, expect } from "@playwright/test";
import { onPixelGrid, snapViewport } from "../../lib/board/viewport-pixels";

/* The board's viewport on whole device pixels (lib/board/viewport-pixels.ts; the sharpness audit's first item). Pure. */
test("x and y snap to the device's pixel grid; zoom is left alone", () => {
  expect(snapViewport({ x: 10.4, y: -20.6, zoom: 1.2 }, 1)).toEqual({ x: 10, y: -21, zoom: 1.2 });
  expect(snapViewport({ x: 10.3, y: -20.8, zoom: 1 }, 2)).toEqual({ x: 10.5, y: -21, zoom: 1 });
  expect(snapViewport({ x: 10.3, y: 7.1, zoom: 0.5 }, 3)).toEqual({ x: 10.333333333333334, y: 7, zoom: 0.5 });
  expect(snapViewport({ x: 0.5, y: 0.5, zoom: 1 }, 1)).toEqual({ x: 1, y: 1, zoom: 1 });
});

test("a viewport already on the grid is returned as it is (the same object), and snapping twice changes nothing", () => {
  for (const dpr of [1, 1.25, 1.5, 2, 3]) {
    const once = snapViewport({ x: 123.456, y: -78.9, zoom: 1.6 }, dpr);
    expect(onPixelGrid(once, dpr), String(dpr)).toBe(true);
    expect(snapViewport(once, dpr)).toBe(once);
  }
  const v = { x: 4, y: 8, zoom: 1 };
  expect(snapViewport(v, 1)).toBe(v);
});

test("a ratio that is not a number, or under 1, is read as 1", () => {
  expect(snapViewport({ x: 1.4, y: 1.6, zoom: 1 }, Number.NaN)).toEqual({ x: 1, y: 2, zoom: 1 });
  expect(snapViewport({ x: 1.4, y: 1.6, zoom: 1 }, 0)).toEqual({ x: 1, y: 2, zoom: 1 });
  expect(onPixelGrid({ x: 1.5, y: 2, zoom: 1 }, 1)).toBe(false);
  expect(onPixelGrid({ x: 1.5, y: 2, zoom: 1 }, 2)).toBe(true);
});
