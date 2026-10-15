import { test, expect, type Browser, type Page } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { signInToRedesign } from "./helpers/newInterface";
import { screenScale } from "../lib/v12/board/screen-scale";

/**
 * Large screens (owner, 15 Oct 2026, 22:30). The board is drawn for 1440 x 900; above 1440 px wide its canvas scales up to fill the window, as a
 * zoom-to-fit would (bigger cards, the same layout, their words and chips scaling with them, lib/v12/board/screen-scale.ts), while the top bar, the
 * rail, the bottom bar and every button stay their own size and centred. At each of the five sizes the owner reviews (1280x800, 1440x900, 1728x1117,
 * 1920x1080, 2560x1440): no sideways scroll; the bars keep their size and their place; the cards are the scale larger and none is stranded outside the
 * canvas; the words are never smaller than at 1440 and at 2560 never under 12 px; the cards fill the canvas as far down as they do at 1440; and every picture
 * on the board has at least as many pixels as it is drawn with (never upscaled past its real pixels), at a pixel ratio of 1 and of 2.
 * Set LARGE_SCREENS_DIR to keep a screenshot of each size. Local ENGINE_MOCK server only; nothing is rendered or spent.
 */
const SIZES = [[1280, 800], [1440, 900], [1728, 1117], [1920, 1080], [2560, 1440]] as const;
const shotsDir = process.env.LARGE_SCREENS_DIR;

async function openShots(page: Page) {
  const signed = await signInToRedesign(page.request, "Large Screen Tester");
  const me = (await (await page.request.get("/api/me")).json()) as { id: string };
  const scope = `particl-active-${signed.workspace.id}-${me.id}`;
  const made = await page.request.post("/api/workbench/projects", { headers: { "X-Workbench-Scope": scope }, data: { action: "starter" } });
  expect(made.ok(), await made.text()).toBe(true);
  const id = ((await made.json()) as { project: { id: string } }).project.id;
  await page.goto(`/suites?view=board&project=${encodeURIComponent(id)}`);
  await expect(page.getByTestId("board")).toBeVisible({ timeout: 60_000 });
  await page.locator('[data-testid="v12-stage-row"][data-stage="shots"]').click();
  await expect(page.locator('[data-testid="take-card"]').first()).toBeVisible({ timeout: 60_000 });
  /* The pictures are drawn (a video's poster is captured first). */
  await expect(page.locator('[data-testid="take-card"] img').first()).toBeVisible({ timeout: 60_000 });
}

async function measure(page: Page) {
  return page.evaluate(() => {
    const box = (el: Element | null) => { const r = el?.getBoundingClientRect(); return r ? { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height } : null; };
    const canvas = document.querySelector(".v12-stage-canvas");
    /* The size a word is drawn at: its font size, times how much the canvas drew its box larger than its layout (a scaled node). */
    let smallest = Infinity;
    let smallestOf = "";
    for (const el of Array.from(document.querySelectorAll<HTMLElement>('[data-testid="board"] *'))) {
      const own = Array.from(el.childNodes).some((n) => n.nodeType === 3 && (n.textContent ?? "").trim().length > 0);
      if (!own) continue;
      const r = el.getBoundingClientRect();
      if (r.width < 1 || r.height < 1 || getComputedStyle(el).visibility === "hidden" || getComputedStyle(el).display === "none") continue;
      const drawn = el.offsetWidth > 0 ? r.width / el.offsetWidth : 1;
      const size = parseFloat(getComputedStyle(el).fontSize) * drawn;
      if (size < smallest) { smallest = size; smallestOf = `${el.tagName.toLowerCase()} "${(el.textContent ?? "").trim().slice(0, 30)}"`; }
    }
    const cards = Array.from(document.querySelectorAll('[data-testid="take-card"]')).map((c) => ({ card: box(c), pic: box(c.querySelector("img, video")) }));
    return {
      vw: window.innerWidth, vh: window.innerHeight, overflow: document.documentElement.scrollWidth - window.innerWidth,
      header: box(document.querySelector('[data-testid="v12-header"]')), rail: box(document.querySelector('[data-testid="v12-stage-rail"]')),
      stageHead: box(document.querySelector('[data-testid="v12-stage-header"]')), bar: box(document.querySelector('[data-testid="v12-board-bar"]')),
      canvas: box(canvas), cards, smallest, smallestOf,
    };
  });
}

const near = (a: number, b: number, tol: number, what: string) => expect(Math.abs(a - b), `${what}: ${a} vs ${b}`).toBeLessThanOrEqual(tol);

test("at the five sizes the canvas is scaled up, the bars keep their size and place, no card is stranded and no word is small", async ({ page }, info) => {
  test.skip(info.project.name !== "workbench-1440x900", "one project walks all five sizes");
  test.setTimeout(420_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  await openShots(page);
  const seen: Record<string, Awaited<ReturnType<typeof measure>>> = {};
  for (const [w, h] of SIZES) {
    await page.setViewportSize({ width: w, height: h });
    await page.waitForTimeout(1500);
    await expect(page.locator('[data-testid="take-card"] img').first()).toBeVisible();
    const m = await measure(page);
    seen[`${w}`] = m;
    console.log(`${w}x${h}: scale ${screenScale(w, h)}, smallest word ${m.smallest.toFixed(1)} px (${m.smallestOf}), picture ${Math.round(m.cards[0].pic!.width)} px wide`);
    if (shotsDir) { await mkdir(shotsDir, { recursive: true }); await page.screenshot({ path: path.join(shotsDir, `board-${w}x${h}.png`) }); }
    expect(m.overflow, `${w}x${h}: no sideways scroll`).toBeLessThanOrEqual(0);
    expect(m.cards.length, `${w}x${h}: the shot cards`).toBeGreaterThanOrEqual(3);
  }
  const base = seen["1440"];
  for (const [w, h] of SIZES) {
    const m = seen[`${w}`];
    const label = `${w}x${h}`;
    const scale = screenScale(w, h);
    /* The bars: the top bar spans the window at its own height; the rail keeps its width and sits under it; the bottom bar keeps its height and is centred on the canvas. */
    near(m.header!.left, 0, 0.5, `${label} top bar left`);
    near(m.header!.right, m.vw, 0.5, `${label} top bar right`);
    near(m.header!.height, base.header!.height, 0.5, `${label} top bar height`);
    near(m.rail!.width, base.rail!.width, 0.5, `${label} rail width`);
    expect(m.rail!.top, `${label} rail under the top bar`).toBeGreaterThanOrEqual(m.header!.bottom - 0.5);
    near(m.stageHead!.height, base.stageHead!.height, 0.5, `${label} stage header height`);
    near(m.stageHead!.left, m.canvas!.left, 1, `${label} stage header on the canvas column`);
    near(m.stageHead!.right, m.canvas!.right, 1, `${label} stage header on the canvas column`);
    near(m.bar!.height, base.bar!.height, 0.5, `${label} bottom bar height`);
    /* Centred on the canvas, unless that would put it over the bottom-left controls (Library and the view switch): then its left edge is 420 px in (components/v12/board/board-bar.css). At 2560 it is centred. */
    const wide = m.canvas!.width;
    const centre = m.canvas!.left + Math.max(wide / 2, 420 + m.bar!.width / 2);
    near((m.bar!.left + m.bar!.right) / 2, centre, 2, `${label} bottom bar where the frame puts it`);
    if (w >= 2560) near((m.bar!.left + m.bar!.right) / 2, (m.canvas!.left + m.canvas!.right) / 2, 2, `${label} bottom bar centred on the canvas`);
    /* The cards: the scale larger than at 1440, every one inside the canvas, in the same row. */
    const pic = (x: typeof m) => x.cards[0].pic!.width;
    near(pic(m) / pic(base), scale, 0.03 * scale, `${label} picture scale`);
    for (const c of m.cards) {
      expect(c.card!.left, `${label} a card inside the canvas`).toBeGreaterThanOrEqual(m.canvas!.left - 1);
      expect(c.card!.right, `${label} a card inside the canvas`).toBeLessThanOrEqual(m.canvas!.right + 1);
      expect(c.card!.bottom, `${label} a card inside the canvas`).toBeLessThanOrEqual(m.canvas!.bottom + 1);
    }
    /* Nothing is left behind: the cards reach down the canvas the scale further than at 1440 (what is left below them is the stage's own content, as at 1440). */
    const reach = (x: typeof m) => Math.max(...x.cards.map((c) => c.card!.bottom)) - x.canvas!.top;
    expect(reach(m), `${label} cards reach ${scale}x as far down the canvas as at 1440`).toBeGreaterThanOrEqual(reach(base) * scale * 0.93);
    /* The words: never smaller than at 1440, and 12 px or more at 2560. */
    expect(m.smallest, `${label} smallest word: ${m.smallestOf}`).toBeGreaterThanOrEqual(base.smallest - 0.05);
    if (w >= 2560) expect(m.smallest, `${label} smallest word: ${m.smallestOf}`).toBeGreaterThanOrEqual(12);
  }
});

async function sharp(browser: Browser, width: number, height: number, ratio: number) {
  const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: ratio, baseURL: test.info().project.use.baseURL });
  try {
    const page = await context.newPage();
    await openShots(page);
    await page.waitForTimeout(3000);
    /* Every picture on the board has at least as many pixels as it is drawn with (a poster is captured as wide as it is drawn), or all the pixels its source has: the sample clip is 640 wide. */
    await expect.poll(async () => page.evaluate(({ r, SAMPLE_CLIP_WIDTH }) => {
      const short = Array.from(document.querySelectorAll<HTMLImageElement>('[data-testid="board"] img')).filter((img) => img.complete && img.naturalWidth > 0 && Math.floor(img.naturalWidth) < Math.min(Math.floor(img.getBoundingClientRect().width * r), SAMPLE_CLIP_WIDTH) - 1);
      return short.map((img) => `${img.naturalWidth}px for ${Math.round(img.getBoundingClientRect().width * r)}`);
    }, { r: ratio, SAMPLE_CLIP_WIDTH: 640 }), { timeout: 30_000, message: `${width}x${height} at ${ratio}x: no picture is drawn larger than its pixels` }).toEqual([]);
    expect(await page.evaluate(() => document.querySelectorAll('[data-testid="board"] img').length), "there are pictures to check").toBeGreaterThan(0);
    /* The logo is a vector (the mark is an SVG) and its wordmark has at least the pixels it is drawn with (PNG only today: the owner is to supply an SVG wordmark). */
    const logo = await page.evaluate((r) => {
      const mark = document.querySelector<HTMLImageElement>('[data-testid="v12-logo"] :is(.v12-logo-mark, .brand-logo-mark) img');
      const word = document.querySelector<HTMLImageElement>('[data-testid="v12-logo"] :is(.v12-logo-word, .brand-logo-word) img');
      return { mark: mark?.currentSrc ?? "", wordLoaded: Boolean(word?.complete), /* naturalWidth is the picture's width divided by its srcset density (a 256 px file served as 2x reads 128): the file's own width is the w= it was asked at. */
        wordNatural: Number(new URL(word?.currentSrc || "http://x", "http://x").searchParams.get("w")) || (word?.naturalWidth ?? 0), wordDrawn: Math.round((word?.getBoundingClientRect().width ?? 0) * r) };
    }, ratio);
    expect(new URL(logo.mark, "http://x").pathname.endsWith(".svg"), `${width}x${height} at ${ratio}x: the mark is a vector`).toBe(true);
    expect(logo.wordLoaded && logo.wordDrawn > 0, "the wordmark is drawn").toBe(true);
    expect(logo.wordNatural, `${width}x${height} at ${ratio}x: the wordmark has the pixels it is drawn with`).toBeGreaterThanOrEqual(logo.wordDrawn - 1);
  } finally {
    await context.close();
  }
}

test("pictures are sharp at 1728 x 1117 and 2560 x 1440, at a pixel ratio of 1 and of 2: none is drawn with more pixels than it has", async ({ browser }, info) => {
  test.skip(info.project.name !== "workbench-1440x900", "one project");
  test.setTimeout(420_000);
  for (const [w, h] of [[1728, 1117], [2560, 1440]] as const) for (const ratio of [1, 2]) await sharp(browser, w, h, ratio);
});
