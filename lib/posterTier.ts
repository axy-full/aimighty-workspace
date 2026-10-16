/**
 * A poster is captured at the size its picture is drawn at, never upscaled past its real pixels (owner, 15 Oct 2026): the tier at or above the
 * picture's width on screen times the screen's pixel ratio (a board scaled up on a large screen is measured as drawn), and never above the video's own
 * width. 480 is the size every wall has always had; a larger tier is captured only where a picture is drawn that large.
 */
export const POSTER_TIERS = [480, 960, 1440, 1920] as const;
export function posterTier(cssWidth: number, pixelRatio = 1): number {
  const need = (Number.isFinite(cssWidth) ? cssWidth : 0) * Math.min(2, Math.max(1, pixelRatio || 1));
  return POSTER_TIERS.find((tier) => tier >= need) ?? POSTER_TIERS[POSTER_TIERS.length - 1];
}
