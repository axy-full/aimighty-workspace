import { test, type Page } from "@playwright/test";
import { mkdirSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import sharp from "sharp";

/**
 * Screenshots for the PR description: the routes that changed, at each
 * viewport, signed out, plus the composer sheet open. Written under
 * docs/phase-0/ so the description can point at them by path.
 *
 * WRITTEN ONLY WHEN THE PICTURE ACTUALLY CHANGED.
 *
 * These are committed, because a PR that changes what a screen looks like
 * should carry the new screen. But Chromium does not rasterise the same page
 * to the same bytes twice: measured on /welcome at 390x844, two runs minutes
 * apart differed in 448 pixels of 329,160 — 0.14% of the frame, none of them
 * by more than 3 levels out of 255, all of them on the anti-aliased edges of
 * the lockup's circles and wordmark. Invisible, and enough to rewrite the
 * file. Every suite run therefore dirtied the tree, so every PR carried
 * binary churn that had to be committed as noise or discarded by hand.
 *
 * So a shot is compared against the one on disk and kept unless it moved
 * more than a rasteriser can move it. Two ways to be a real change, because
 * either alone lets something through: ONE pixel moving a lot (text, layout,
 * anything appearing or going) or a LITTLE movement across a lot of the frame
 * (a colour token shifting a couple of levels everywhere).
 */

/** A channel moving by no more than this, on its own, is the rasteriser. */
const NOISE_LEVELS = 8;
/** ...unless it moved this much of the frame, which is a colour, not an edge. */
const NOISE_SHARE = 0.005;

async function movedForReal(before: Buffer, after: Buffer): Promise<boolean> {
  const [a, b] = await Promise.all([
    sharp(before).raw().toBuffer({ resolveWithObject: true }),
    sharp(after).raw().toBuffer({ resolveWithObject: true }),
  ]);
  // A different size is a different screen; no need to look at pixels.
  if (a.info.width !== b.info.width || a.info.height !== b.info.height) return true;
  if (a.info.channels !== b.info.channels || a.data.length !== b.data.length) return true;
  const ch = a.info.channels;
  let moved = 0;
  for (let i = 0; i < a.data.length; i += ch) {
    let d = 0;
    for (let c = 0; c < ch; c++) {
      const x = Math.abs(a.data[i + c] - b.data[i + c]);
      if (x > d) d = x;
    }
    if (d > NOISE_LEVELS) return true;
    if (d > 0) moved++;
  }
  return moved / (a.info.width * a.info.height) > NOISE_SHARE;
}

/**
 * `animations: "disabled"` and `caret: "hide"` are not what was flapping —
 * the lockup is neither — but a spinner caught mid-turn or a blinking caret
 * would flap far harder than anti-aliasing does, and both are free to rule
 * out. They change the committed images once, deliberately.
 */
async function shoot(page: Page, file: string): Promise<void> {
  const shot = await page.screenshot({ scale: "css", animations: "disabled", caret: "hide" });
  if (existsSync(file) && !(await movedForReal(readFileSync(file), shot))) return;
  writeFileSync(file, shot);
}
const SHOTS: [string, string][] = [
  ["/welcome", "welcome"], ["/", "generate"], ["/images", "images"], ["/audio", "audio"],
  ["/projects", "productions"], ["/studio", "studio"], ["/studio/shot", "shot-builder"],
  ["/usage", "usage"], ["/settings", "settings"], ["/atomik/ideas", "atomik-ideas"], ["/atomik/shots", "atomik-shots"],
];

/**
 * Wait for the page to be FINISHED, not merely quiet.
 *
 * `networkidle` plus a fixed pause was not enough, and the committed shots
 * showed it: `welcome-390x844.png` was the lockup alone, centred on an empty
 * page, because the capture landed before the sign-in half of the screen
 * existed. A screenshot of a half-drawn screen is worse than none — it is
 * offered as evidence of what a change did.
 *
 * That is also where the "anti-aliasing noise" came from. The differing
 * pixels sat exactly on the lockup's circles, because what was being
 * photographed was a page still assembling itself, and it had assembled a
 * slightly different amount each time.
 *
 * Three signals rather than a longer sleep: nothing is still talking, no
 * spinner is on screen (every one of them carries `role="status"`), and the
 * fonts have arrived — text laid out in a fallback face and then reflowed is
 * the other way a capture lands mid-render.
 */
async function settle(page: Page) {
  await page.waitForLoadState("domcontentloaded");
  await page.waitForLoadState("networkidle").catch(() => {});
  await page.waitForFunction(() => !document.querySelector('[role="status"]'), null, { timeout: 15_000 })
    .catch(() => { /* a page that is legitimately still loading is still worth a picture */ });
  await page.evaluate(() => document.fonts.ready).catch(() => {});
  await page.waitForTimeout(400);
}

test.describe("screens", () => {
  test("capture", async ({ page }, info) => {
    mkdirSync("docs/phase-0", { recursive: true });
    const vp = page.viewportSize()!;
    const tag = `${vp.width}x${vp.height}`;
    for (const [route, slug] of SHOTS) {
      await page.goto(route);
      await settle(page);
      await shoot(page, `docs/phase-0/${slug}-${tag}.png`);
    }
    await page.goto("/");
    await settle(page);
    await page.locator(".dock-preview").click();
    await page.waitForTimeout(500);
    await shoot(page, `docs/phase-0/sheet-${tag}.png`);
    info.annotations.push({ type: "shots", description: `${SHOTS.length + 1} screenshots at ${tag}` });
  });
});
