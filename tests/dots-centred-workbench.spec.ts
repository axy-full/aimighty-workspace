import { test, expect, type Locator } from "@playwright/test";
import sharp from "sharp";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { openBoard } from "./helpers/boardV12";
import { mockMedia } from "./helpers/workspaceFixtures";

/**
 * Every ⋯ button draws its three dots in the middle of the button (owner, 13 Oct: "the three dots sit slightly left of centre inside the button"). Measured
 * on the pixels, as the eye sees it: the dots' ink (inside the button's own border) is centred on the button's box to within a pixel, horizontally and
 * vertically. The board header's ⋯ at both desktop sizes, a stage row's ⋯ on the rail, and the board header's again on a second stage. Desktop only: the new
 * interface is desktop only and the phone app has no ⋯ button. Set DOTS_SHOTS to save the buttons, enlarged, to that folder.
 */
const SIZES = [{ width: 1440, height: 900 }, { width: 1280, height: 800 }];
const SHOTS = process.env.DOTS_SHOTS;

/** Where the dots' ink sits in the button, from its own screenshot: the offset of the ink's centre from the button's centre, in CSS pixels. */
async function offset(button: Locator, name: string, tag: string) {
  const box = (await button.boundingBox())!;
  const png = await button.screenshot({ animations: "disabled" });
  const { data, info } = await sharp(png).greyscale().raw().toBuffer({ resolveWithObject: true });
  const scale = info.width / box.width;
  /* Inside the 1 px border: the dots only. Ink is anything clearly lighter than the button's own background. */
  const inset = Math.ceil(2 * scale);
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (let y = inset; y < info.height - inset; y++) for (let x = inset; x < info.width - inset; x++) {
    if (data[y * info.width + x] > 110) { minX = Math.min(minX, x); maxX = Math.max(maxX, x + 1); minY = Math.min(minY, y); maxY = Math.max(maxY, y + 1); }
  }
  expect(maxX, `${name}: dots drawn`).toBeGreaterThan(minX);
  if (SHOTS) {
    mkdirSync(SHOTS, { recursive: true });
    await sharp(png).resize({ width: info.width * 8, kernel: "nearest" }).toFile(path.join(SHOTS, `${name}-${tag}.png`));
  }
  return { x: (minX + maxX) / 2 / scale - box.width / 2, y: (minY + maxY) / 2 / scale - box.height / 2 };
}
const centred = async (button: Locator, name: string, tag: string) => {
  const off = await offset(button, name, tag);
  expect.soft(Math.abs(off.x), `${name} horizontal offset ${off.x.toFixed(2)} px`).toBeLessThanOrEqual(1);
  expect.soft(Math.abs(off.y), `${name} vertical offset ${off.y.toFixed(2)} px`).toBeLessThanOrEqual(1);
};

test.describe("desktop", () => {
  test.beforeEach(({}, info) => test.skip(info.project.name !== "workbench-1440x900" && info.project.name !== "workbench-1920x1080", "desktop sizes"));

  test("the ⋯ in the board header is centred at 1440x900 and 1280x800, and a stage row's on the rail", async ({ page }) => {
    test.setTimeout(240_000);
    await openBoard(page, "/suites?view=board&stage=shots");
    await mockMedia(page);
    const header = page.getByTestId("v12-board-menu");
    await expect(header).toBeVisible({ timeout: 90_000 });
    for (const size of SIZES) {
      await page.setViewportSize(size);
      await page.waitForTimeout(400);
      await centred(header, "board-header", `${size.width}x${size.height}`);
    }
    await page.setViewportSize(SIZES[0]);
    /* A row on the stage rail shows its ⋯ on hover. */
    const row = page.locator(".v12-rail-row").first();
    await row.hover();
    await centred(row.getByTestId("v12-stage-menu"), "stage-row", "1440x900");
    /* The header again on another stage: the same button, drawn by the same component. */
    await page.goto("/suites?view=board&stage=cast");
    await expect(page.getByTestId("v12-board-menu")).toBeVisible({ timeout: 60_000 });
    await centred(page.getByTestId("v12-board-menu"), "board-header-cast", "1440x900");
  });
});
