/**
 * Whole device pixels for the board's viewport (owner, 16 Oct 2026: sharpness at 5K and 6K; the audit's first item). The canvas is drawn through one transform,
 * `translate(x, y) scale(zoom)`; when x or y falls between two device pixels every border and every edge on the board is drawn half on a pixel and goes soft,
 * even at zoom 1. A centred glide, a trackpad's scroll and a resize all produce such fractions. Snapping x and y to the device's pixel grid (a whole number
 * of CSS pixels at 1×, a multiple of a half at 2×, of a third at 3×) leaves the picture where it was to the eye and puts every edge on a pixel. Zoom is left as it is.
 * Pure: no window (the caller says the ratio).
 */
export type ViewportLike = { x: number; y: number; zoom: number };

const ratio = (dpr: number) => (Number.isFinite(dpr) && dpr >= 1 ? dpr : 1);
const onGrid = (value: number, dpr: number) => Math.round(value * dpr) / dpr;

/** The viewport with x and y on the device's pixel grid. The same object when it already is, so a caller can tell nothing changed. */
export function snapViewport<T extends ViewportLike>(viewport: T, dpr = 1): T {
  const r = ratio(dpr);
  const x = onGrid(viewport.x, r), y = onGrid(viewport.y, r);
  return x === viewport.x && y === viewport.y ? viewport : { ...viewport, x, y };
}

/** Whether x and y are already on the device's pixel grid (to a thousandth of a pixel, so a float's tail is not a fraction). */
export function onPixelGrid(viewport: ViewportLike, dpr = 1): boolean {
  const r = ratio(dpr);
  const whole = (value: number) => Math.abs(value * r - Math.round(value * r)) < 0.001;
  return whole(viewport.x) && whole(viewport.y);
}

/** The ratio to snap to in the browser; 1 where there is no window. */
export const deviceRatio = (): number => (typeof window === "undefined" ? 1 : ratio(window.devicePixelRatio));
