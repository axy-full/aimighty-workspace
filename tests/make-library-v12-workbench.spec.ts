import { test, expect } from "@playwright/test";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { openBoard } from "./helpers/boardV12";

/**
 * In Make, the bottom-left Library button and the L key open the same Library tray over Make (owner, 13 Oct): the address stays on Make, Esc closes the tray,
 * and picking a tile adds it to the composer as a reference, as @ does. The button used to open the board's Library drawer, which left Make for the board.
 * Desktop only (the new interface's Make). Set MAKE_LIBRARY_SHOTS to save the screenshots.
 */
const SHOTS = process.env.MAKE_LIBRARY_SHOTS;
const SIZES = [{ width: 1440, height: 900 }, { width: 1280, height: 800 }];

test.describe("desktop", () => {
  test.beforeEach(({}, info) => test.skip(info.project.name !== "workbench-1440x900" && info.project.name !== "workbench-1920x1080", "desktop sizes"));

  test("Library in Make opens the tray over Make, from the button and from L; Esc closes it; a tile picked adds a reference", async ({ page }) => {
    test.setTimeout(300_000);
    const { errors } = await openBoard(page, "/suites?view=make");
    const make = page.getByTestId("v12-make");
    const tray = page.getByTestId("v12-library");
    const here = () => new URL(page.url());
    const onMake = () => { const u = here(); return u.pathname === "/suites" && u.searchParams.has("make") && u.searchParams.get("view") !== "board"; };
    await expect(make).toBeVisible({ timeout: 90_000 });
    expect(onMake()).toBe(true);

    for (const size of SIZES) {
      await page.setViewportSize(size);
      await page.waitForTimeout(300);
      /* The button. */
      await page.getByTestId("v12-make-library").click();
      await expect(tray).toBeVisible();
      expect(onMake(), `the address stays on Make: ${page.url()}`).toBe(true);
      await expect(make).toBeVisible();
      if (SHOTS) { mkdirSync(SHOTS, { recursive: true }); await page.screenshot({ path: path.join(SHOTS, `make-library-open-${size.width}x${size.height}.png`) }); }
      /* Esc closes it, and Make is still here. */
      await page.keyboard.press("Escape");
      await expect(tray).toHaveCount(0);
      expect(onMake()).toBe(true);
      await expect(make).toBeVisible();
      /* L, with nothing in a field: the same tray. And L does not fire while typing in a field. */
      await page.locator("body").click({ position: { x: 5, y: 300 } });
      await page.keyboard.press("l");
      await expect(tray).toBeVisible();
      expect(onMake()).toBe(true);
      await page.keyboard.press("Escape");
      await expect(tray).toHaveCount(0);
      const words = page.getByTestId("v12-make-bar-input");
      await words.click();
      await page.keyboard.type("l");
      await expect(tray).toHaveCount(0);
      await expect(words).toHaveValue("l");
      await words.fill("");
    }

    /* Picking a tile: a reference chip in the composer, the same as @. */
    await page.setViewportSize(SIZES[0]);
    await expect(page.getByTestId("v12-make-ref")).toHaveCount(0);
    await page.getByTestId("v12-make-library").click();
    await expect(tray).toBeVisible();
    const tile = page.getByTestId("v12-library-tile").first();
    await expect(tile).toBeVisible({ timeout: 60_000 });
    await tile.click();
    await expect(page.getByTestId("v12-make-ref")).toHaveCount(1, { timeout: 30_000 });
    expect(onMake()).toBe(true);
    await expect(make).toBeVisible();
    if (SHOTS) await page.screenshot({ path: path.join(SHOTS, "make-library-picked-tray-open-1440x900.png") });
    await page.keyboard.press("Escape");
    await expect(tray).toHaveCount(0);
    await expect(page.getByTestId("v12-make-ref")).toHaveCount(1);
    if (SHOTS) await page.screenshot({ path: path.join(SHOTS, "make-library-picked-1440x900.png") });
    expect(errors).toEqual([]);
  });
});
