import { expect, test, type Browser, type Locator, type Page } from "@playwright/test";
import { noOverflow } from "./visitorV12";
import { OWNER_WINDOWS } from "./ownerSizes";

/**
 * Large screens (owner, 15 Oct 2026, 22:30), for the logo wherever it is drawn: a vector mark, a wordmark with at least the pixels it is drawn with (it is PNG only in
 * public/brand today: the owner is to supply an SVG wordmark), at the sizes the owner reviews and at a pixel ratio of 1 and of 2; its own size at every screen size; its
 * header spans the window; nothing scrolls sideways. Local ENGINE_MOCK server only.
 * The sizes are the owner's seven captures (tests/helpers/ownerSizes.ts, 16 Oct 2026); the logo is walked at a pixel ratio of 1 and of 2 at every one of them, a superset of the
 * pixel ratio each size is reviewed at.
 */
/* One entry per window size: 2560x1440 is reviewed at two ratios, and both are walked below. */
export const SIZES = OWNER_WINDOWS;

export async function logoFacts(logo: Locator, ratio: number) {
  return logo.evaluate((el, r) => {
    const mark = el.querySelector<HTMLImageElement>(".brand-logo-mark img")!;
    const word = el.querySelector<HTMLImageElement>(".brand-logo-word img")!;
    const box = el.getBoundingClientRect();
    /* naturalWidth is a picture's width divided by its srcset density (a 256 px file served as 2x reads 128): the file's own width is the w= it was asked at. */
    const fileWidth = Number(new URL(word.currentSrc || "http://x", "http://x").searchParams.get("w")) || word.naturalWidth;
    return { markSrc: mark.currentSrc, wordLoaded: word.complete && word.naturalWidth > 0, wordPixels: fileWidth, wordDrawn: Math.round(word.getBoundingClientRect().width * r), width: box.width, height: box.height };
  }, ratio);
}

export async function checkLogo(page: Page, logo: Locator, header: Locator, label: string, ratio: number, base: { width: number; height: number } | null) {
  await expect(logo, `${label}: the logo`).toBeVisible({ timeout: 60_000 });
  await expect.poll(async () => (await logoFacts(logo, ratio)).wordLoaded, { message: `${label}: the wordmark loaded` }).toBe(true);
  const facts = await logoFacts(logo, ratio);
  expect(new URL(facts.markSrc, "http://x").pathname.endsWith(".svg"), `${label}: the mark is a vector`).toBe(true);
  expect(facts.wordPixels, `${label} at ${ratio}x: the wordmark has the pixels it is drawn with`).toBeGreaterThanOrEqual(facts.wordDrawn - 1);
  if (base) {
    expect(Math.abs(facts.width - base.width), `${label}: the logo stays its own size`).toBeLessThanOrEqual(0.5);
    expect(Math.abs(facts.height - base.height), `${label}: the logo stays its own size`).toBeLessThanOrEqual(0.5);
  }
  const bar = await header.evaluate((el) => { const r = el.getBoundingClientRect(); return { left: r.left, right: r.right, vw: window.innerWidth }; });
  expect(Math.abs(bar.left), `${label}: the header spans the window`).toBeLessThanOrEqual(0.5);
  expect(Math.abs(bar.right - bar.vw), `${label}: the header spans the window`).toBeLessThanOrEqual(0.5);
  await noOverflow(page, label);
  return { width: facts.width, height: facts.height };
}

/** Each size at a pixel ratio of 1 and of 2, in a fresh context (so the screen is drawn at that size from its first byte). */
export async function walkSizes(browser: Browser, name: string, open: (page: Page) => Promise<{ logo: Locator; header: Locator }>) {
  const baseURL = test.info().project.use.baseURL;
  for (const ratio of [1, 2]) {
    let base: { width: number; height: number } | null = null;
    for (const [w, h] of SIZES) {
      const context = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: ratio, baseURL });
      try {
        const page = await context.newPage();
        const { logo, header } = await open(page);
        const size = await checkLogo(page, logo, header, `${name} at ${w}x${h}`, ratio, base);
        base ??= size;
      } finally { await context.close(); }
    }
  }
}
