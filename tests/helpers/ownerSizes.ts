/**
 * The seven captures the owner reviews every v25/v26 screen at (owner, 16 Oct 2026, 15:05; 2560x1440 at both ratios from 15:50), as
 * [width, height, deviceScaleFactor]: 1280x800, 1440x900, 1728x1117 and 1920x1080 at a pixel ratio of 1, 2560x1440 at 1 and at 2
 * (the Studio Display), and 3008x1692 (Pro Display XDR) at 2.
 * One list for the redesign Playwright config, the large-screen specs and the screenshot helpers, so a size is added once.
 * Plain data: no Playwright import, so the config can load it.
 */
export type OwnerSize = readonly [width: number, height: number, dpr: number];

export const OWNER_SIZES: readonly OwnerSize[] = [
  [1280, 800, 1],
  [1440, 900, 1],
  [1728, 1117, 1],
  [1920, 1080, 1],
  [2560, 1440, 1],
  [2560, 1440, 2],
  [3008, 1692, 2],
];

/** The window sizes, once each (2560x1440 is reviewed at two ratios), for a walk that resizes one page and so cannot change its pixel ratio. */
export const OWNER_WINDOWS: readonly (readonly [width: number, height: number])[] = [...new Map(OWNER_SIZES.map(([w, h]) => [`${w}x${h}`, [w, h] as const])).values()];

/** "1920x1080", or "2560x1440@2x" when the pixel ratio is not 1: the name of a project and the tag of a screenshot. */
export function sizeTag(width: number, height: number, dpr = 1): string {
  return `${width}x${height}${dpr === 1 ? "" : `@${dpr}x`}`;
}

/** A Playwright project for a size: `<prefix>-<tag>`, with its viewport and pixel ratio. */
export function sizeProjects(prefix: string) {
  return OWNER_SIZES.map(([width, height, dpr]) => ({
    name: `${prefix}-${sizeTag(width, height, dpr)}`,
    use: { browserName: "chromium" as const, viewport: { width, height }, deviceScaleFactor: dpr },
  }));
}
