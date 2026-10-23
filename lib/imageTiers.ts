import { assetIdFromUrl } from "@/lib/preview";

/**
 * Pictures at the size the screen needs (owner, 16 Oct 2026, 15:05: "every image served at ≥2× its displayed size via srcset").
 * A Particl still is offered to the browser as width tiers through `srcset`, each one a downscale of the original made by
 * `/api/workbench/preview/<kind>/<id>?w=<tier>` (never wider than the original: a tier at or above its width is the original),
 * and `sizes` is the width the picture is drawn at, measured on screen, so a board scaled up on a large screen asks for more.
 * The browser multiplies `sizes` by the screen's pixel ratio, so a 2x screen gets two file pixels per CSS pixel.
 * Anything that is not a Particl still (a vendor URL, a data: URL, a file under /public) is left as it is.
 */
export const IMAGE_TIERS = [320, 640, 960, 1280, 1920, 2560, 3840] as const;
export type ImageTier = (typeof IMAGE_TIERS)[number];

/** The tier a `?w=` asks for, or null when it is not one (the route answers 404, so the cache only ever holds these). */
export function parseTier(value: string | null): ImageTier | null {
  if (value == null) return null;
  const n = Number(value);
  return (IMAGE_TIERS as readonly number[]).includes(n) && String(n) === value ? (n as ImageTier) : null;
}

/** The tier route for a Particl still at one width, or null for any other URL. */
export function tierUrl(url: string, width: ImageTier): string | null {
  const id = assetIdFromUrl(url);
  if (!id) return null;
  const [kind, raw] = id.split(":");
  return `/api/workbench/preview/${kind}/${raw}?w=${width}`;
}

/** The `srcset` for a Particl still (every tier, with its width), or undefined for any other URL. */
export function imageSrcSet(url: string): string | undefined {
  if (!assetIdFromUrl(url)) return undefined;
  return IMAGE_TIERS.map((w) => `${tierUrl(url, w)} ${w}w`).join(", ");
}

/**
 * The width a picture's file is drawn at, in CSS px, in a box measured on screen (getBoundingClientRect, so a zoomed board
 * counts), for `object-fit: cover`: a picture wider than its box (a 16:9 still in a square well) is scaled to the box's height
 * and drawn wider than the box. `aspect` is the file's width / height once it is known; before, the box's own width.
 */
export function coverWidth(box: { width: number; height: number } | null | undefined, aspect?: number | null): number | null {
  if (!box || !(box.width > 0) || !(box.height > 0)) return null;
  return aspect && Number.isFinite(aspect) && aspect > 0 ? Math.max(box.width, box.height * aspect) : box.width;
}

/**
 * The `sizes` for a picture whose file is drawn `drawnCssWidth` CSS px wide on screen. Rounded up to a whole pixel; before it
 * has been measured, the window's width (sharp, only heavier than it needs to be until measured).
 */
export function imageSizes(drawnCssWidth: number | null | undefined): string {
  return drawnCssWidth && Number.isFinite(drawnCssWidth) && drawnCssWidth > 0 ? `${Math.ceil(drawnCssWidth)}px` : "100vw";
}
