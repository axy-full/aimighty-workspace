import { test, expect, type Page } from "@playwright/test";
import sharp from "sharp";
import { describeSoft, expectSharpMedia, findSoftMedia } from "./helpers/sharpMedia";

/**
 * The sharpness check (tests/helpers/sharpMedia.ts, owner 16 Oct 2026, 15:05): at a pixel ratio of 2 a picture, video frame or poster
 * drawn with more than half a file pixel per CSS pixel is soft and fails. These cases are the helper's own proof, on pictures made
 * here and served from a made-up origin: nothing from the app, nothing rendered or spent.
 */
test.use({ deviceScaleFactor: 2 });

const ORIGIN = "https://sharp.test";
const png = (width: number, height: number) => sharp({ create: { width, height, channels: 3, background: { r: 200, g: 60, b: 20 } } }).png().toBuffer();

async function serve(page: Page, body: string) {
  await page.route(`${ORIGIN}/**`, async (route) => {
    const url = new URL(route.request().url());
    const m = /^\/p-(\d+)x(\d+)\.png$/.exec(url.pathname);
    if (m) return route.fulfill({ body: await png(Number(m[1]), Number(m[2])), contentType: "image/png" });
    if (url.pathname === "/v.svg") return route.fulfill({ body: '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10"/></svg>', contentType: "image/svg+xml" });
    if (url.pathname === "/") return route.fulfill({ body: `<!doctype html><meta name=viewport content="width=device-width"><style>body{margin:0}</style>${body}`, contentType: "text/html" });
    return route.fulfill({ status: 404 });
  });
  await page.goto(`${ORIGIN}/`);
  await page.waitForFunction(() => Array.from(document.images).every((i) => i.complete));
}

test.beforeEach(({}, info) => { test.skip(info.project.name !== "workbench-1440x900", "one project: it needs no app and no size"); });

test("a picture drawn at exactly half its file pixels per CSS pixel is sharp; a hair more is soft", async ({ page }) => {
  await serve(page, `<img id=ok src="/p-800x400.png" width=400 height=200><img id=soft src="/p-800x400.png" width=420 height=210>`);
  const soft = await findSoftMedia(page);
  expect(soft.map((m) => m.selector)).toEqual(["img#soft"]);
  expect(soft[0].file).toEqual({ width: 800, height: 400 });
  expect(describeSoft(soft[0])).toMatch(/file 800x400 px, drawn 420x210 CSS px x 2 = 840x420 px/);
});

test("it measures the file's real pixels, not naturalWidth: a srcset 2x candidate drawn at its own CSS size is sharp, a 1x candidate is soft", async ({ page }) => {
  await serve(page, `
    <img id=two src="/p-200x100.png" srcset="/p-200x100.png 200w, /p-800x400.png 800w" sizes="400px" width=400 height=200>
    <img id=one src="/p-400x200.png" srcset="/p-400x200.png 1x" width=400 height=200>`);
  /* The browser reads the 800 px file at density 2 as naturalWidth 400, which a naturalWidth check would call a fit of 1 for 1: wrong the other way for the 1x file. */
  expect(await page.locator("#two").evaluate((i: HTMLImageElement) => [i.naturalWidth, i.currentSrc.endsWith("p-800x400.png")])).toEqual([400, true]);
  expect((await findSoftMedia(page)).map((m) => m.selector)).toEqual(["img#one"]);
});

test("object-fit counts: cover is judged by the larger axis, contain by the smaller, fill by each", async ({ page }) => {
  await serve(page, `
    <img id=cover src="/p-1000x500.png" style="width:300px;height:300px;object-fit:cover">
    <img id=contain src="/p-1000x500.png" style="width:300px;height:300px;object-fit:contain">
    <img id=fill src="/p-1000x500.png" style="width:300px;height:300px;object-fit:fill">
    <img id=squash src="/p-1000x500.png" style="width:300px;height:600px;object-fit:fill">`);
  /* cover: 300/500 = 0.6 per file px (soft); contain: 300/1000 = 0.3 (sharp); fill 300x300: 0.3 and 0.6 (soft on the vertical); fill 300x600: 1.2 (soft). */
  expect((await findSoftMedia(page)).map((m) => m.selector).sort()).toEqual(["img#cover", "img#fill", "img#squash"]);
});

test("padding and border are not picture: the box is the content box", async ({ page }) => {
  await serve(page, `<img id=a src="/p-400x400.png" style="box-sizing:border-box;width:240px;height:240px;padding:20px;border:10px solid #fff;object-fit:fill">`);
  /* 240 - 2*(20+10) = 180 CSS px for 400 file px: sharp (the 240 px box alone would be 0.6). */
  expect(await findSoftMedia(page)).toEqual([]);
});

test("the page's own zoom counts: a scaled parent draws the same picture larger", async ({ page }) => {
  await serve(page, `<div style="transform:scale(1.6);transform-origin:0 0"><img id=z src="/p-640x360.png" width=360 height=203></div>`);
  /* 360 x 1.6 = 576 CSS px drawn for 640 file px. */
  const soft = await findSoftMedia(page);
  expect(soft.map((m) => m.selector)).toEqual(["img#z"]);
  expect(soft[0].drawn.width).toBeCloseTo(576, 0);
});

test("a vector is never soft; data-sharp-exempt on the picture or an ancestor is the only way out", async ({ page }) => {
  await serve(page, `
    <img id=svg src="/v.svg" width=900 height=900>
    <img id=data src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='4' height='4'%3E%3C/svg%3E" width=900 height=900>
    <div data-sharp-exempt="blurred-source"><img id=blurred src="/p-100x100.png" width=400 height=400></div>
    <img id=own data-sharp-exempt="test" src="/p-100x100.png" width=400 height=400>
    <img id=bare src="/p-100x100.png" width=400 height=400>`);
  expect((await findSoftMedia(page)).map((m) => m.selector)).toEqual(["img#bare"]);
});

test("a video's poster is judged like a picture (a take shows it at rest)", async ({ page }) => {
  await serve(page, `
    <video id=sharp poster="/p-1600x900.png" width=800 height=450 muted></video>
    <video id=soft poster="/p-640x360.png" width=800 height=450 muted></video>`);
  const soft = await findSoftMedia(page);
  expect(soft.map((m) => `${m.kind} ${m.selector}`)).toEqual(["poster video#soft"]);
  expect(soft[0].file).toEqual({ width: 640, height: 360 });
});

test("backgrounds are checked only when asked", async ({ page }) => {
  await serve(page, `<div id=bg style="width:500px;height:300px;background:url(/p-400x240.png) center/cover"></div>`);
  expect(await findSoftMedia(page)).toEqual([]);
  expect((await findSoftMedia(page, { backgrounds: true })).map((m) => `${m.kind} ${m.selector}`)).toEqual(["background div#bg"]);
});

test("expectSharpMedia passes when everything is sharp, fails listing each soft picture, and fails on a page with no media", async ({ page }) => {
  await serve(page, `<img src="/p-800x400.png" width=400 height=200>`);
  expect((await expectSharpMedia(page, { settle: 300 })).checked).toBe(1);
  await serve(page, `<img src="/p-800x400.png" width=400 height=200><img src="/p-100x100.png" width=300 height=300>`);
  const failure = await expectSharpMedia(page, { timeout: 1_500, settle: 100 }).then(() => "", (e: Error) => e.message);
  expect(failure).toContain("p-100x100.png");
  expect(failure).toContain("file 100x100 px, drawn 300x300 CSS px x 2 = 600x600 px");
  expect(failure).not.toContain("p-800x400.png");
  await serve(page, `<p>nothing here</p>`);
  expect(await expectSharpMedia(page, { settle: 100 }).then(() => "", (e: Error) => e.message)).toContain("there is media on the page to check");
});

test("a picture that is soft only until it is swapped for a sharper one passes once it has", async ({ page }) => {
  await serve(page, `<img id=late src="/p-100x100.png" width=300 height=300>`);
  setTimeout(() => { void page.evaluate(() => { (document.getElementById("late") as HTMLImageElement).src = "/p-800x800.png"; }); }, 800);
  await expectSharpMedia(page, { settle: 500 });
});

test("below a pixel ratio of 2 the check refuses to run (a 1x candidate would pass for the wrong reason)", async ({ browser }) => {
  const context = await browser.newContext({ deviceScaleFactor: 1 });
  try {
    const page = await context.newPage();
    await serve(page, `<img src="/p-800x400.png" width=400 height=200>`);
    await expect(findSoftMedia(page)).rejects.toThrow(/needs a pixel ratio of 2/);
  } finally { await context.close(); }
});
