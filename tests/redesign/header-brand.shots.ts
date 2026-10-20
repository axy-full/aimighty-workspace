import { test, expect } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { signInLocally } from "../helpers/workbenchLocal";

/*
 * Today's customer header (components/graphite/Header.tsx) at the five rule-7 widths, for before and after the brand wordmark. Run once per server with
 * SHOT_LABEL=before|after; writes <REDESIGN_SHOTS_DIR>/<label>/<w>x<h>.png (the page) and <w>x<h>-header.png (its top 110 px). A touch screen at the three phone sizes.
 */
const SIZES = [[360, 640], [390, 844], [844, 390], [1280, 800], [1440, 900], [1920, 1080]] as const;
test.use({ hasTouch: true });
test("the customer header, before or after", async ({ page }, info) => {
  test.skip(info.project.name !== "redesign-1440x900", "once");
  await signInLocally(page.request, "Header Shots");
  const dir = path.resolve(process.env.REDESIGN_SHOTS_DIR ?? "../redesign-shots", process.env.SHOT_LABEL ?? "after");
  await mkdir(dir, { recursive: true });
  for (const [w, h] of SIZES) {
    await page.setViewportSize({ width: w, height: h });
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto("/suites?view=home");
    await expect(page.locator("header.gx-header, [data-testid=phone-app]").first()).toBeVisible({ timeout: 60_000 });
    await page.waitForTimeout(1200);
    expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth), `${w}x${h} overflow`).toBeLessThanOrEqual(0);
    await page.screenshot({ path: path.join(dir, `${w}x${h}.png`) });
    await page.screenshot({ path: path.join(dir, `${w}x${h}-header.png`), clip: { x: 0, y: 0, width: w, height: Math.min(110, h) } });
  }
});
