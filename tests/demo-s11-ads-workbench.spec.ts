import { test, expect } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { SHOTS, adsUrl, desktop, seedAds } from "./helpers/s11-board";

test("Ads board: first look", async ({ page }) => {
  test.skip(!desktop(page), "the canvas is desktop only");
  const { project } = await seedAds(page);
  await page.goto(adsUrl(project.id, "&frame=1"));
  await expect(page.locator('[data-card-id="group:ads-start"]')).toBeVisible({ timeout: 60_000 });
  await page.waitForTimeout(2500);
  mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: `${SHOTS}/ads-first-look.png` });
});
