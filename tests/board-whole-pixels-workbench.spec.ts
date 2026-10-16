import { test, expect, type Page } from "@playwright/test";
import { openShotsBoard } from "./helpers/shotsV12";

/*
 * The board's viewport on whole device pixels (lib/board/viewport-pixels.ts; the owner's sharpness target, 16 Oct 2026, audit item 1): the canvas's
 * `translate(x, y) scale(k)` has whole x and y when the stage opens, after a centred glide, and after a trackpad-style scroll that moves it by a fraction,
 * so no border on the board is drawn between two device pixels. Real routes, seeded rows; desktop with the switch on. Nothing is generated.
 */
const DESKTOP = ["workbench-1440x900", "workbench-1920x1080"];
const viewport = (page: Page) => page.locator(".react-flow__viewport").evaluate((el) => {
  const m = new DOMMatrixReadOnly(getComputedStyle(el).transform);
  return { x: m.e, y: m.f, k: m.a, dpr: window.devicePixelRatio };
});
const whole = (v: { x: number; y: number; dpr: number }) => Math.abs(v.x * v.dpr - Math.round(v.x * v.dpr)) < 0.01 && Math.abs(v.y * v.dpr - Math.round(v.y * v.dpr)) < 0.01;

test.beforeEach(({}, info) => test.skip(!DESKTOP.includes(info.project.name), "desktop sizes"));

test("the stage opens on whole device pixels, and a fractional scroll settles on them", async ({ page }) => {
  test.setTimeout(180_000);
  await openShotsBoard(page, "/suites?view=board&stage=shots");
  await expect(page.locator('.bd-node[data-card-kind="take"]')).toHaveCount(8, { timeout: 90_000 });
  await expect.poll(async () => whole(await viewport(page)), { timeout: 20_000 }).toBe(true);
  const open = await viewport(page);
  /* A trackpad scrolls by fractions: the view moves, and once it stops it is on the pixel grid again. */
  const canvas = page.getByTestId("board-canvas");
  const box = (await canvas.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.wheel(3.3, 14.7);
  await expect.poll(async () => { const v = await viewport(page); return whole(v) && (v.x !== open.x || v.y !== open.y); }, { timeout: 20_000 }).toBe(true);
  /* A glide ends on the grid too: "Fit to view" (the board menu) glides to a fraction-laden viewport, and it must actually move the view. */
  const before = await viewport(page);
  await page.getByTestId("v12-board-menu").click();
  await page.getByRole("menuitem", { name: "Fit to view" }).click();
  await expect.poll(async () => { const v = await viewport(page); return whole(v) && (Math.abs(v.x - before.x) > 1 || Math.abs(v.y - before.y) > 1 || Math.abs(v.k - before.k) > 0.01); }, { timeout: 20_000 }).toBe(true);
});

test("on a 2x screen x and y land on half pixels: twice them are whole numbers", async ({ browser, baseURL }, info) => {
  test.setTimeout(180_000);
  const context = await browser.newContext({ deviceScaleFactor: 2, viewport: info.project.use.viewport ?? { width: 1440, height: 900 }, baseURL: baseURL ?? undefined });
  try {
    const page = await context.newPage();
    await openShotsBoard(page, "/suites?view=board&stage=shots");
    await expect(page.locator('.bd-node[data-card-kind="take"]')).toHaveCount(8, { timeout: 90_000 });
    expect(await page.evaluate(() => window.devicePixelRatio)).toBe(2);
    await expect.poll(async () => { const v = await viewport(page); return v.dpr === 2 && Number.isInteger(Math.round(v.x * 2 * 1000) / 1000) && Math.abs(v.x * 2 - Math.round(v.x * 2)) < 0.01 && Math.abs(v.y * 2 - Math.round(v.y * 2)) < 0.01; }, { timeout: 20_000 }).toBe(true);
    const canvas = page.getByTestId("board-canvas");
    const box = (await canvas.boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.wheel(3.3, 14.7);
    await expect.poll(async () => { const v = await viewport(page); return Math.abs(v.x * 2 - Math.round(v.x * 2)) < 0.01 && Math.abs(v.y * 2 - Math.round(v.y * 2)) < 0.01; }, { timeout: 20_000 }).toBe(true);
  } finally { await context.close(); }
});
