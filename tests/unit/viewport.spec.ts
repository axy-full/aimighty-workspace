import { test, expect } from "@playwright/test";
import { zoomAround, wheelFactor, panBy, stepZoom, resetZoom, fitView, pinchView, clampZoom, loadView, saveView, viewKey, boardHeight, BOARD_FLOOR, BOARD_GAP, BOARD_MIN, ZOOM_MIN, ZOOM_MAX, ZOOM_STEP, DEFAULT_VIEW, type View } from "../../lib/viewport";

/**
 * The Rig canvas viewport (Suites Rig graph; change request 1 §6): zoom about the
 * cursor, pan with a plain wheel, step and fit, pinch, and the remembered
 * view — as numbers, so the acceptance ("port dots align at 25% and 200%")
 * rests on the one transform every consumer shares.
 */
const v0: View = { pan: { x: 40, y: 30 }, zoom: 1 };
const under = (v: View, at: { x: number; y: number }) => ({ x: (at.x - v.pan.x) / v.zoom, y: (at.y - v.pan.y) / v.zoom });

test("zooming about a point keeps what was under it under it", () => {
  const at = { x: 300, y: 200 };
  const before = under(v0, at);
  for (const factor of [1.25, 0.5, 2, 0.31]) {
    const v1 = zoomAround(v0, at, factor);
    const after = under(v1, at);
    expect(after.x).toBeCloseTo(before.x, 6);
    expect(after.y).toBeCloseTo(before.y, 6);
  }
});

test("zoom is clamped to 10%–200% and a no-op returns the same view", () => {
  expect(zoomAround(v0, { x: 0, y: 0 }, 100).zoom).toBe(ZOOM_MAX);
  expect(zoomAround(v0, { x: 0, y: 0 }, 0.001).zoom).toBe(ZOOM_MIN);
  const atMax = zoomAround(v0, { x: 0, y: 0 }, 100);
  expect(zoomAround(atMax, { x: 50, y: 50 }, 2)).toBe(atMax);
  expect(clampZoom(0.05)).toBe(0.1); expect(clampZoom(0.25)).toBe(0.25); expect(clampZoom(3)).toBe(2); expect(clampZoom(1.5)).toBe(1.5);
});

test("a pinch in and the same pinch out cancel", () => {
  const inF = wheelFactor(-8), outF = wheelFactor(8);
  expect(inF).toBeGreaterThan(1); expect(outF).toBeLessThan(1);
  expect(inF * outF).toBeCloseTo(1, 10);
  // lines and pages scale to pixels; a huge delta is bounded to one gentle step
  expect(wheelFactor(-1, 1)).toBeCloseTo(wheelFactor(-16), 10);
  expect(wheelFactor(-1000)).toBeCloseTo(Math.exp(0.6), 10);
});

test("a plain wheel pans against the delta; steps and reset go about the given point", () => {
  expect(panBy(v0, 10, -5).pan).toEqual({ x: 30, y: 35 });
  expect(panBy(v0, 0, 0)).toBe(v0);
  const c = { x: 400, y: 300 };
  const stepped = stepZoom(v0, 1, c);
  expect(stepped.zoom).toBeCloseTo(ZOOM_STEP, 10);
  expect(under(stepped, c).x).toBeCloseTo(under(v0, c).x, 6);
  expect(stepZoom(stepped, -1, c).zoom).toBeCloseTo(1, 10);
  const far = zoomAround(v0, c, 1.7);
  expect(resetZoom(far, c).zoom).toBe(1);
  expect(under(resetZoom(far, c), c).y).toBeCloseTo(under(far, c).y, 6);
});

test("fit shows every node inside the margin, centred, never above 100%", () => {
  const boxes = [{ x: 0, y: 0, w: 200, h: 120 }, { x: 900, y: 500, w: 250, h: 300 }];
  const surface = { w: 1000, h: 600 };
  const v = fitView(boxes, surface);
  expect(v.zoom).toBeLessThanOrEqual(1);
  expect(v.zoom).toBeGreaterThanOrEqual(ZOOM_MIN);
  for (const b of boxes) {
    const l = v.pan.x + b.x * v.zoom, t = v.pan.y + b.y * v.zoom, r = l + b.w * v.zoom, bt = t + b.h * v.zoom;
    expect(l).toBeGreaterThanOrEqual(48 - 1); expect(t).toBeGreaterThanOrEqual(48 - 1);
    expect(r).toBeLessThanOrEqual(surface.w - 48 + 1); expect(bt).toBeLessThanOrEqual(surface.h - 48 + 1);
  }
  // one small node fits at 100%, centred
  const one = fitView([{ x: 500, y: 500, w: 200, h: 100 }], surface);
  expect(one.zoom).toBe(1);
  expect(one.pan.x + 500 + 100).toBe(500); expect(one.pan.y + 500 + 50).toBe(300);
  expect(fitView([], surface)).toEqual(DEFAULT_VIEW);
});

test("a pinch zooms about where the fingers started and follows their midpoint", () => {
  const start = { view: v0, dist: 100, mid: { x: 300, y: 300 } };
  const spread = pinchView(start, 200, { x: 300, y: 300 });
  expect(spread.zoom).toBe(2);
  expect(under(spread, start.mid).x).toBeCloseTo(under(v0, start.mid).x, 6);
  const moved = pinchView(start, 100, { x: 340, y: 280 });
  expect(moved.zoom).toBe(1);
  expect(moved.pan).toEqual({ x: 80, y: 10 });
});

test("the remembered view round-trips per board per user and rejects junk", () => {
  const store: Record<string, string> = {};
  (globalThis as unknown as { localStorage: Storage }).localStorage = {
    getItem: (k: string) => store[k] ?? null, setItem: (k: string, v: string) => { store[k] = v; }, removeItem: (k: string) => { delete store[k]; },
    clear: () => { for (const k of Object.keys(store)) delete store[k]; }, key: () => null, length: 0,
  } as Storage;
  const key = viewKey("mara@studio", "brd_1");
  expect(key).toBe("aw_rigview:mara@studio:brd_1");
  saveView(key, { pan: { x: 12.6, y: -3.2 }, zoom: 1.5 });
  expect(loadView(key)).toEqual({ pan: { x: 13, y: -3 }, zoom: 1.5 });
  expect(loadView(viewKey("mara@studio", "brd_2"))).toBeNull();
  store[key] = "{\"zoom\":\"big\"}";
  expect(loadView(key)).toBeNull();
  store[key] = "{\"zoom\":9,\"pan\":{\"x\":0,\"y\":0}}";
  expect(loadView(key)?.zoom).toBe(ZOOM_MAX);
});

test("the board fills its pane below it, never under the floor where there is room, and never past what the pane shows", () => {
  /* Desktops (measured at 1440x900 and 1920x1080): the floor, then the room below. */
  expect(boardHeight({ top: 285, bottom: 889, padBottom: 0 }, 478, 900)).toBe(BOARD_FLOOR);
  expect(boardHeight({ top: 285, bottom: 1069, padBottom: 0 }, 444, 1080)).toBe(1069 - BOARD_GAP - 444);
  /* Phones: the pane keeps 110px clear for the tab bar; the board starts below the fold, so it is what the pane shows at once. */
  const phone = boardHeight({ top: 428, bottom: 844, padBottom: 110 }, 750, 844);
  expect(phone).toBe(844 - 110 - BOARD_GAP - 428);
  expect(428 + phone).toBeLessThanOrEqual(844 - 110);
  /* A phone on its side or the smallest phone shows less than a row of takes: the board keeps one, and the pane scrolls. */
  expect(boardHeight({ top: 266, bottom: 390, padBottom: 0 }, 426, 390)).toBe(BOARD_MIN);
  expect(boardHeight({ top: 372, bottom: 640, padBottom: 110 }, 700, 640)).toBe(BOARD_MIN);
  /* Never taller than the pane shows, even where the floor would be. */
  expect(boardHeight({ top: 0, bottom: 380, padBottom: 0 }, 40, 380)).toBe(380 - BOARD_GAP);
  /* A pane scrolled partly off the top counts only what is on screen. */
  expect(boardHeight({ top: -100, bottom: 300, padBottom: 0 }, 900, 600)).toBe(300 - BOARD_GAP);
});
