/*
 * The design's easing, cubic-bezier(.2, .7, .2, 1) (README § 2, `--gx-ease`), as a function of time for the
 * board's glides (.35 s). Solved for x by bisection, then read off y.
 */
export function cubicBezier(x1: number, y1: number, x2: number, y2: number): (t: number) => number {
  const at = (a: number, b: number, t: number) => 3 * a * t * (1 - t) ** 2 + 3 * b * t ** 2 * (1 - t) + t ** 3;
  return (x: number) => {
    if (x <= 0) return 0;
    if (x >= 1) return 1;
    let lo = 0, hi = 1, t = x;
    for (let i = 0; i < 24; i++) {
      t = (lo + hi) / 2;
      if (at(x1, x2, t) < x) lo = t; else hi = t;
    }
    return at(y1, y2, t);
  };
}
export const glideEase = cubicBezier(0.2, 0.7, 0.2, 1);
/** README § 2: board glides .35 s. */
export const GLIDE_MS = 350;
