/**
 * How much the board's canvas is scaled up on a large screen (owner, 15 Oct 2026, 22:30): the layout is drawn for 1440 x 900, and above
 * 1440 px wide the canvas scales up to fill the window, as a zoom-to-fit would: bigger cards, the same layout, their text and chips scaling
 * with them. The bars, the rail and every button stay their own size and centred; only the canvas's own viewport zoom changes. At or
 * below 1440 px wide it is 1, so every size the board is already reviewed at is exactly as it was. Pure: no window, safe anywhere.
 */
export const REFERENCE_WIDTH = 1440;
export const REFERENCE_HEIGHT = 900;
/** The most a screen is scaled: a 2880 x 1800 screen is 2, and nothing above it grows further. */
export const MAX_SCREEN_SCALE = 2;

export function screenScale(width: number, height: number): number {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= REFERENCE_WIDTH || height <= 0) return 1;
  const fit = Math.min(width / REFERENCE_WIDTH, height / REFERENCE_HEIGHT);
  return Math.round(Math.min(MAX_SCREEN_SCALE, Math.max(1, fit)) * 100) / 100;
}
