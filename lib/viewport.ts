/**
 * The Rig canvas viewport (rebuilt for the Suites Rig graph from change request 1 §6): zoom and pan as
 * pure functions over `{ pan, zoom }`, so the wheel handler, the pinch,
 * the keyboard and the `+ / − / fit` cluster all move the same numbers
 * and a unit test can check each without a browser.
 *
 * Zoom is a CSS transform on the board group (`translate(pan) scale(zoom)`),
 * never a scaled bitmap, so node text stays crisp and wire endpoints —
 * drawn in the same group — stay exact at every level. Range 10%–200%.
 * The view is remembered per board per user in localStorage.
 */
export type Point = { x: number; y: number };
export type View = { pan: Point; zoom: number };

/** 10%: a feature's Rig runs to hundreds of shots, and Fit must be able to show them all. */
export const ZOOM_MIN = 0.1;
export const ZOOM_MAX = 2;
/** One keyboard or button step: ⌘= / ⌘- and the cluster's + / −. */
export const ZOOM_STEP = 1.25;
export const DEFAULT_VIEW: View = { pan: { x: 0, y: 0 }, zoom: 1 };

export const clampZoom = (z: number): number => Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, z));

/**
 * Zoom by `factor` about `at` — a point in surface pixels, measured from the
 * surface's top-left — so whatever was under the cursor stays under it. The
 * board point under `at` is `(at − pan) / zoom`; keeping it fixed at the new
 * zoom gives the new pan. Clamped; a factor that changes nothing returns the
 * same view.
 */
export function zoomAround(v: View, at: Point, factor: number): View {
  const zoom = clampZoom(v.zoom * factor);
  if (zoom === v.zoom) return v;
  const k = zoom / v.zoom;
  return { zoom, pan: { x: at.x - (at.x - v.pan.x) * k, y: at.y - (at.y - v.pan.y) * k } };
}

/**
 * A wheel's zoom factor. Trackpad pinch arrives as `wheel` with `ctrlKey`
 * and small deltas (±1…±10); ⌘-scroll on a mouse wheel arrives in larger
 * steps, or in lines (`deltaMode` 1). `exp` keeps a pinch in and the same
 * pinch out symmetrical.
 */
export function wheelFactor(deltaY: number, deltaMode = 0): number {
  const px = deltaMode === 1 ? deltaY * 16 : deltaMode === 2 ? deltaY * 400 : deltaY;
  return Math.exp(-Math.max(-60, Math.min(60, px)) * 0.01);
}

/** A plain wheel pans: the content follows the gesture, so the pan moves against the delta. */
export function panBy(v: View, dx: number, dy: number): View {
  if (!dx && !dy) return v;
  return { ...v, pan: { x: v.pan.x - dx, y: v.pan.y - dy } };
}

/** ⌘= / ⌘- and the cluster: one step in or out about a point (the surface's centre). */
export const stepZoom = (v: View, dir: 1 | -1, at: Point): View => zoomAround(v, at, dir > 0 ? ZOOM_STEP : 1 / ZOOM_STEP);

/** Back to 100% about a point, keeping what is under it. */
export const resetZoom = (v: View, at: Point): View => zoomAround(v, at, 1 / v.zoom);

export type Box = { x: number; y: number; w: number; h: number };

/**
 * Fit every node into the surface with a margin, centred, at the largest
 * zoom in range that shows them all (never above 100% — fitting one small
 * node should not blow it up). An empty board fits to 100% at the origin.
 */
export function fitView(boxes: readonly Box[], surface: { w: number; h: number }, margin = 48): View {
  if (!boxes.length || surface.w <= 0 || surface.h <= 0) return DEFAULT_VIEW;
  const minX = Math.min(...boxes.map((b) => b.x)), minY = Math.min(...boxes.map((b) => b.y));
  const maxX = Math.max(...boxes.map((b) => b.x + b.w)), maxY = Math.max(...boxes.map((b) => b.y + b.h));
  const w = Math.max(1, maxX - minX), h = Math.max(1, maxY - minY);
  const zoom = clampZoom(Math.min(1, (surface.w - 2 * margin) / w, (surface.h - 2 * margin) / h));
  return {
    zoom,
    pan: { x: Math.round((surface.w - w * zoom) / 2 - minX * zoom), y: Math.round((surface.h - h * zoom) / 2 - minY * zoom) },
  };
}

/** Pinch: two pointers' distance and midpoint. */
export const distance = (a: Point, b: Point): number => Math.hypot(b.x - a.x, b.y - a.y);
export const midpoint = (a: Point, b: Point): Point => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });

/**
 * Where a pinch that started at `start` (the view then, the fingers'
 * distance and midpoint then) has taken the view now: zoom about the start
 * midpoint by the distance ratio, then follow the midpoint's travel.
 */
export function pinchView(start: { view: View; dist: number; mid: Point }, dist: number, mid: Point): View {
  const zoomed = zoomAround(start.view, start.mid, start.dist > 0 ? dist / start.dist : 1);
  return { ...zoomed, pan: { x: zoomed.pan.x + (mid.x - start.mid.x), y: zoomed.pan.y + (mid.y - start.mid.y) } };
}

/* ── remembered per board per user ─────────────────────────────────── */
export const viewKey = (userKey: string, boardId: string): string => `aw_rigview:${userKey}:${boardId}`;

export function loadView(key: string): View | null {
  try {
    const raw = typeof localStorage === "undefined" ? null : localStorage.getItem(key);
    if (!raw) return null;
    const v = JSON.parse(raw) as Partial<View>;
    if (typeof v.zoom !== "number" || !v.pan || typeof v.pan.x !== "number" || typeof v.pan.y !== "number") return null;
    if (![v.zoom, v.pan.x, v.pan.y].every(Number.isFinite)) return null;
    return { zoom: clampZoom(v.zoom), pan: { x: v.pan.x, y: v.pan.y } };
  } catch { return null; }
}

export function saveView(key: string, v: View): void {
  try { localStorage.setItem(key, JSON.stringify({ zoom: v.zoom, pan: { x: Math.round(v.pan.x), y: Math.round(v.pan.y) } })); } catch { /* private mode, or storage full — the view simply is not remembered */ }
}
